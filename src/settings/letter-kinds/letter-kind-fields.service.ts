import { BadRequestException, Injectable } from '@nestjs/common';
import { LetterFieldSource } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';
import { extractTokens } from '../../recruitment/letters/letter-tokens.util';

/** One declared field, as a template editor and a renderer both need it. */
export interface LetterFieldView {
  token: string;
  label: string;
  sourceType: LetterFieldSource;
  sourcePath: string | null;
  isRequired: boolean;
}

/**
 * Paths no letter field may read, whatever a kind declares (017 FR-024, task T141).
 *
 * **A kind must not be able to declare its way past a PII gate.** FR-024 keeps regulated personal
 * data out of letters, and the moment a kind's field list became company-editable, an administrator
 * gained a way to put Aadhaar into a signed document by naming the column. This is the list that
 * stops it, checked against the declared `sourcePath` at save and again at render.
 *
 * Matched on the **path**, and on any path containing one of these, because `aadhaarEncrypted` and
 * `employee.aadhaarEncrypted` are the same disclosure. Encrypted column names are included because a
 * resolver reading one would hand back ciphertext — which is not a leak but is a letter with a
 * meaningless string where a number should be, and somebody would then "fix" it by decrypting.
 */
export const FORBIDDEN_FIELD_PATH_FRAGMENTS: readonly string[] = [
  'aadhaar',
  'pan',
  'bankAccountNumber',
  'bankAccountNumberEncrypted',
  'passwordHash',
  'faceEmbedding',
  'biometric',
];

/**
 * What a letter kind's templates may reference (017 FR-011b, FR-011c) — `bugs.md` item 18.
 *
 * ## The coupling this undoes
 *
 * `LETTER_TOKENS` is keyed by the five letter types this product ships. FR-011 lets an administrator
 * define a kind without a code change — and such a kind got an **empty** token list, so
 * `unknownTokens` validated nothing and the renderer had no values to supply. The template editor
 * then refused every field it used. Both requirements were satisfied and together they produced
 * nothing usable.
 *
 * ## Validated at save **and** at render
 *
 * FR-011c asks for both, and the second is not redundant: a template saved while a field was declared
 * would otherwise render a blank where a salary should be, after somebody removed the field from the
 * kind. A blank in a signed letter is indistinguishable from a deliberate omission.
 *
 * ## One shared field list was offered and declined
 *
 * The client declined it precisely because it would offer exit-settlement fields in an offer letter's
 * editor. So validation is always against **the template's own kind**.
 */
@Injectable()
export class LetterKindFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Declares or replaces one field on a kind (FR-011b).
   *
   * An upsert on `(letterKindId, token)` rather than a create: editing a field's label or source is
   * the common case, and a create-then-delete dance would briefly leave a saved template referencing
   * a field its kind did not declare — which is the exact state `assertTemplateFieldsDeclared`
   * refuses at render.
   */
  async upsertField(
    ctx: RlsContext,
    letterKindId: string,
    input: {
      token: string;
      label: string;
      sourceType: LetterFieldSource;
      sourcePath?: string | null;
      isRequired?: boolean;
    },
  ): Promise<LetterFieldView> {
    const sourcePath =
      input.sourceType === LetterFieldSource.manual
        ? null
        : input.sourcePath?.trim() ?? null;

    // The pairing the database also enforces, checked here so the caller gets a sentence rather than
    // a constraint violation.
    if (input.sourceType !== LetterFieldSource.manual && !sourcePath) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'LETTER_FIELD_PATH_REQUIRED',
        message:
          `A ${input.sourceType} field needs the path its value is read from. Without one it is a ` +
          `placeholder that renders blank — and a blank in a signed letter cannot be told apart ` +
          `from a deliberate omission. Use "manual" for a value typed at issue time.`,
      });
    }
    if (input.sourceType === LetterFieldSource.manual && input.sourcePath) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'LETTER_FIELD_PATH_NOT_ALLOWED',
        message:
          'A manual field is typed at issue time and reads no record, so it takes no path.',
      });
    }

    this.assertPathPermitted(sourcePath);

    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.letterKindField.upsert({
        where: {
          letterKindId_token: { letterKindId, token: input.token },
        },
        create: {
          letterKindId,
          token: input.token,
          label: input.label.trim(),
          sourceType: input.sourceType,
          sourcePath,
          isRequired: input.isRequired ?? false,
        },
        update: {
          label: input.label.trim(),
          sourceType: input.sourceType,
          sourcePath,
          isRequired: input.isRequired ?? false,
        },
      }),
    );
    return {
      token: row.token,
      label: row.label,
      sourceType: row.sourceType,
      sourcePath: row.sourcePath,
      isRequired: row.isRequired,
    };
  }

  /**
   * Which of this kind's templates reference a token (017 FR-011b, web T136).
   *
   * **A warning, not a gate.** `removeField` below is deliberately not refused while templates use
   * the field — an administrator tidying a kind should not be blocked by a draft somebody
   * abandoned. But "this will break three templates, and here they are" is information they should
   * have before they decide, and the same shape FR-015 already uses before deleting a template.
   *
   * Served here rather than computed in the browser because the browser cannot get the list: the
   * template endpoints sit under `RECRUITMENT` and this screen under `SETTINGS`, so a caller who may
   * define fields may not be allowed to read templates. Asking the server keeps the warning working
   * for every caller who can reach the screen at all.
   *
   * Matched by tokenising each body rather than by substring, so a field named `site` is not
   * reported as used by a template referencing `{{siteName}}`.
   */
  async templatesUsingField(
    ctx: RlsContext,
    letterKindId: string,
    token: string,
  ): Promise<{ id: string; name: string; isActive: boolean }[]> {
    const templates = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.letterTemplate.findMany({
        where: { letterKindId },
        select: { id: true, name: true, bodyTemplate: true, isActive: true },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      }),
    );
    return templates
      .filter((template) =>
        extractTokens(template.bodyTemplate).includes(token),
      )
      .map(({ id, name, isActive }) => ({ id, name, isActive }));
  }

  /**
   * Removes a declared field.
   *
   * Deliberately **not** guarded on templates using it. A field cannot be withdrawn safely by
   * refusing the delete — the templates referencing it would have to be edited first, and an
   * administrator tidying a kind should not be blocked by a draft somebody abandoned. Instead
   * `assertTemplateFieldsDeclared` refuses at **render**, with a message saying the field was
   * removed, so the failure lands on the person issuing rather than on the person tidying.
   */
  async removeField(
    ctx: RlsContext,
    letterKindId: string,
    token: string,
  ): Promise<void> {
    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.letterKindField.deleteMany({ where: { letterKindId, token } }),
    );
  }

  /** Every field one kind declares. */
  async fieldsFor(
    ctx: RlsContext,
    letterKindId: string,
  ): Promise<LetterFieldView[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.letterKindField.findMany({
        where: { letterKindId },
        orderBy: { token: 'asc' },
      }),
    );
    return rows.map((row) => ({
      token: row.token,
      label: row.label,
      sourceType: row.sourceType,
      sourcePath: row.sourcePath,
      isRequired: row.isRequired,
    }));
  }

  /**
   * Refuses a template body referencing a field its kind does not declare (T136).
   *
   * **Names the field.** "Invalid template" sends somebody re-reading a document they have already
   * read; the token is the one thing they need.
   *
   * A kind with **no** declared fields refuses every token rather than admitting them all. That is
   * the opposite of what `unknownTokens` did, and the reason is that the permissive version is what
   * shipped a broken feature: a kind with no fields and a template full of them renders a page of
   * blanks, signed. The refusal names the remedy — declare the fields.
   */
  async assertTemplateFieldsDeclared(
    ctx: RlsContext,
    letterKindId: string,
    body: string,
    context: 'save' | 'render',
  ): Promise<void> {
    const declared = await this.fieldsFor(ctx, letterKindId);
    const allowed = new Set(declared.map((field) => field.token));
    const used = extractTokens(body);
    const undeclared = used.filter((token) => !allowed.has(token));
    if (undeclared.length === 0) return;

    throw new BadRequestException({
      statusCode: 400,
      code:
        context === 'save'
          ? 'LETTER_FIELD_NOT_DECLARED'
          : 'LETTER_FIELD_NO_LONGER_DECLARED',
      message:
        context === 'save'
          ? `This letter kind does not declare ${undeclared
              .map((t) => `"${t}"`)
              .join(
                ', ',
              )}. Add the field to the kind, with where its value comes from, before ` +
            `using it in a template.`
          : // At render the template is already saved, so the remedy is different and the message
            // has to say which: somebody removed the field after the template was written.
            `This template references ${undeclared
              .map((t) => `"${t}"`)
              .join(
                ', ',
              )}, which its letter kind no longer declares. The letter was not issued, ` +
            `because a blank where a value belongs cannot be told apart from a deliberate omission.`,
      fields: undeclared,
    });
  }

  /**
   * Refuses a declared field that would read regulated personal data (T141).
   *
   * Called when a field is declared, not only when a letter is rendered — a path that can never be
   * used should not be storable. Checked at render too, because a row written before this existed
   * would otherwise still resolve.
   */
  assertPathPermitted(sourcePath: string | null): void {
    if (!sourcePath) return;
    const lowered = sourcePath.toLowerCase();
    const hit = FORBIDDEN_FIELD_PATH_FRAGMENTS.find((fragment) =>
      lowered.includes(fragment.toLowerCase()),
    );
    if (!hit) return;

    throw new BadRequestException({
      statusCode: 400,
      code: 'LETTER_FIELD_PATH_FORBIDDEN',
      message:
        `A letter field may not read "${sourcePath}": it is regulated personal data (FR-024). ` +
        `Defining a kind does not grant a way past that restriction.`,
    });
  }

  /**
   * Resolves a declared field against the records available at issue time.
   *
   * `manual` fields are taken from `supplied` — a term typed at issue, or a figure the issuing
   * service computed. Everything else is read from its named record by path.
   *
   * **A missing required field is a refusal, not a blank.** That is the whole point of `isRequired`:
   * an unresolvable optional field renders empty by design, and an unresolvable required one is a
   * letter nobody should sign.
   */
  resolve(
    fields: LetterFieldView[],
    records: Partial<Record<LetterFieldSource, Record<string, unknown>>>,
    supplied: Record<string, string>,
  ): Record<string, string> {
    const values: Record<string, string> = {};
    const missing: string[] = [];

    for (const field of fields) {
      if (field.sourceType === LetterFieldSource.manual) {
        const value = supplied[field.token];
        if (value === undefined || value === '') {
          if (field.isRequired) missing.push(field.token);
          values[field.token] = '';
          continue;
        }
        values[field.token] = value;
        continue;
      }

      // Re-checked here and not only at declaration: a row written before `assertPathPermitted`
      // existed would otherwise still resolve.
      this.assertPathPermitted(field.sourcePath);

      const record = records[field.sourceType];
      const raw = field.sourcePath
        ? readPath(record, field.sourcePath)
        : undefined;
      if (raw === undefined || raw === null || raw === '') {
        if (field.isRequired) missing.push(field.token);
        values[field.token] = '';
        continue;
      }
      values[field.token] = stringify(raw);
    }

    if (missing.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'LETTER_REQUIRED_FIELD_UNRESOLVED',
        message:
          `This letter cannot be issued: ${missing
            .map((t) => `"${t}"`)
            .join(', ')} ${
            missing.length === 1 ? 'has' : 'have'
          } no value. A blank where a ` +
          `required value belongs is indistinguishable from a deliberate omission.`,
        fields: missing,
      });
    }

    return values;
  }
}

/** A dot path into a plain record. `undefined` at the first step that is not an object. */
function readPath(
  record: Record<string, unknown> | undefined,
  path: string,
): unknown {
  let current: unknown = record;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * A resolved value as it appears in a letter.
 *
 * A `Date` becomes `DD Mon YYYY` and a `Decimal` an Indian-formatted number, because the alternative
 * is an ISO timestamp or `"18000"` in the middle of a sentence. Not locale-dependent: a letter is a
 * document with one correct rendering, not a screen that adapts to its reader.
 */
function stringify(value: unknown): string {
  if (value instanceof Date) {
    return value.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber().toLocaleString('en-IN');
  }
  return String(value);
}
