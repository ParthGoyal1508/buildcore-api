import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  LetterFieldSource,
  Prisma,
  TermsDocumentKind,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import type { ApprovalInstanceView } from '../approvals/approval.types';
import { ApprovalService } from '../approvals/approvals.service';
import { ACTION_LETTER_PURCHASE_ORDER } from '../approvals/default-chains';
import { AuditLogService } from '../auth/audit-log.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../common/prisma/rls-context';
import { StorageService } from '../common/storage/storage.service';
import { DocumentTypesService } from '../settings/reference-data/document-types.service';
import {
  LetterFieldView,
  LetterKindFieldsService,
} from '../settings/letter-kinds/letter-kind-fields.service';
import { LetterKindsService } from '../settings/letter-kinds/letter-kinds.service';
import { LetterTemplatesService } from '../settings/letter-templates/letter-templates.service';
import { SignatoriesService } from '../settings/signatories/signatories.service';
import { ComposeLetterDto, ReissueLetterDto } from './dto/letter.dto';
import {
  LETTER_ALREADY_ISSUED,
  LETTER_KIND_FORBIDDEN,
  LETTER_LINE_ITEMS_UNREADABLE,
  LETTER_NOT_ISSUED,
  LETTER_TEMPLATE_MISSING,
  SIGNATORY_REQUIRED,
} from './letter-error-codes';
import { permissionForKind } from './letter-permissions';
import { LetterRecordSources } from './letter-record-sources';
import {
  BrandHeader,
  formatLetterDate,
  renderLetterPdf,
} from './letter-pdf.renderer';
import { LETTER_LAYOUTS } from './letter-layouts';
import { expandLineItems, LineItemsError } from './line-items';
import { nextReference, referencePrefix } from './letter-reference';
import { assertNoRestrictedTypes, renderTemplate } from './template-resolver';
import { webRoutes } from '../common/web-routes';
import { TermsTemplatesService } from '../settings/terms-templates/terms-templates.service';

/** Where letter PDFs live in blob storage. */
export const LETTER_NAMESPACE = 'letter';

export interface IssuedLetterView {
  id: string;
  letterKindId: string;
  letterKindKey: string;
  letterKindLabel: string;
  employeeId: string | null;
  candidateId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  /**
   * `PRPL/HR/2026-27/0001`, or null for a letter not yet issued (2026-10-11).
   *
   * Exposed because it is what a recipient quotes. A letter findable only by an internal
   * id cannot be looked up from the number printed on the copy in somebody's hand.
   */
  referenceNo: string | null;
  version: number;
  isSuperseded: boolean;
  signatoryId: string | null;
  /** True once the signature graphic has been frozen onto the rendered document. */
  isSigned: boolean;
  issuedAt: Date | null;
  /** FR-018: "issued" until the executed copy comes back, then "executed". */
  status: 'composed' | 'issued' | 'executed';
  countersignedAt: Date | null;
  requiresApproval: boolean;
  /**
   * What was typed at compose, as stored (2026-10-15) — the values the screen sent, never the
   * ones read from records.
   *
   * Returned so the screen that composed a letter can find it again by what it put there: a
   * work order's record sends its own id as an undeclared variable, and lists the LOI and work
   * order letters carrying it. The pair stays opaque — this module stores the values and hands
   * them back; it neither reads nor interprets one. Nothing here is more than the issued
   * document already prints, and the list is filtered by the kind's permission as before.
   */
  composedVariables: Record<string, string>;
  /**
   * Where a composed letter stands in its approval chain, for this caller (2026-10-14).
   *
   * The screens were built to read this — `canActNow` puts Approve / Reject on the letter for the
   * person whose turn it is, and `state: 'approved'` is what offers Issue — and nothing ever sent
   * it. So a gated letter sat at "Composed" with only a Download that could not succeed. Null for
   * an ungated kind, and once no instance exists.
   */
  approval?: ApprovalInstanceView | null;
}

/** One declared field with the value the records give it — what the compose form opens with. */
export interface PrefilledLetterField {
  token: string;
  label: string;
  sourceType: LetterFieldSource;
  isRequired: boolean;
  /** `''` when no record holds it: HR types it, or the letter is refused at issue if required. */
  value: string;
}

export interface LetterPrefillView {
  letterKindKey: string;
  letterKindLabel: string;
  fields: PrefilledLetterField[];
}

/** Who a letter is about, for reading the records its fields resolve against. */
interface LetterRecipient {
  employeeId?: string | null;
  candidateId?: string | null;
  /** A project letter's subject — the record its `project` fields read (2026-10-14). */
  subjectType?: string | null;
  subjectId?: string | null;
}

/** What was typed at compose, as stored. Anything not a string is ignored. */
function composedOf(
  value: Prisma.JsonValue | null | undefined,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

type RlsCtx = ReturnType<typeof rlsContextFor>;

type LetterRow = Prisma.IssuedLetterGetPayload<{
  include: { letterKind: true };
}>;

function toView(row: LetterRow): IssuedLetterView {
  return {
    id: row.id,
    letterKindId: row.letterKindId,
    letterKindKey: row.letterKind.key,
    letterKindLabel: row.letterKind.label,
    employeeId: row.employeeId,
    candidateId: row.candidateId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    /** Null until issued — the number is allocated then, not at compose. */
    referenceNo: row.referenceNo,
    version: row.version,
    isSuperseded: row.isSuperseded,
    signatoryId: row.signatoryId,
    isSigned: row.appliedSignatureRef !== null,
    issuedAt: row.issuedAt,
    status:
      row.countersignedAt !== null
        ? 'executed'
        : row.issuedAt !== null
        ? 'issued'
        : 'composed',
    countersignedAt: row.countersignedAt,
    requiresApproval: row.letterKind.requiresApproval,
    composedVariables: composedOf(row.composedVariables),
  };
}

/**
 * Letters (017 US3, US4, US6).
 *
 * Lives in `src/letters/` and owns `shared.IssuedLetter`. It addresses employees,
 * candidates and an **opaque** `(subjectType, subjectId)` pair that it never
 * dereferences — resolving `vendor-abc` to a vendor name would be the cross-schema read
 * the whole Phase 5 restructure existed to avoid.
 */
@Injectable()
export class LettersService {
  private readonly logger = new Logger(LettersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditLogService,
    private readonly kinds: LetterKindsService,
    private readonly templates: LetterTemplatesService,
    private readonly documentTypes: DocumentTypesService,
    private readonly signatories: SignatoriesService,
    private readonly approvals: ApprovalService,
    private readonly fields: LetterKindFieldsService,
    private readonly records: LetterRecordSources,
    private readonly terms: TermsTemplatesService,
  ) {}

  /**
   * The compose form, filled in from the records (2026-10-13).
   *
   * Every field the kind declares, each with the value the employee, candidate and company
   * records give it — so HR opens a letter that already says who it is to, at what
   * designation, on what pay, and edits only what the system cannot know. A `manual`
   * field, and a record field nobody holds, come back as `''`.
   *
   * **Never refuses for a missing value.** This is the form, not the letter: a blank here
   * is a question for HR, and `compose` is where a required blank becomes a refusal. The
   * per-kind permission is checked all the same, because the values are the employee's pay
   * and exit figures and the kind's permission is what decides who may read them in a
   * letter.
   */
  async prefill(
    caller: AuthenticatedUser,
    query: {
      letterKindKey: string;
      employeeId?: string;
      candidateId?: string;
      subjectType?: string;
      subjectId?: string;
    },
  ): Promise<LetterPrefillView> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const kind = await this.kinds.requireByKey(
      ctx,
      companyId,
      query.letterKindKey,
    );
    this.assertMayActOnKind(caller, kind.key);
    if (query.employeeId && query.candidateId) {
      throw new BadRequestException(
        'A letter is to an employee or to a candidate, not both.',
      );
    }

    const declared = await this.fields.fieldsFor(ctx, companyId, kind.id);
    const records = await this.recordsFor(caller, ctx, companyId, query);
    // Resolved as if nothing were required: the point is to show what is known, and the
    // refusal belongs to the moment somebody tries to issue with a gap.
    const values = this.fields.resolve(
      declared.map((field) => ({ ...field, isRequired: false })),
      records,
      {},
    );

    return {
      letterKindKey: kind.key,
      letterKindLabel: kind.label,
      fields: declared.map((field) => ({
        token: field.token,
        label: field.label,
        sourceType: field.sourceType,
        isRequired: field.isRequired,
        value: values[field.token] ?? '',
      })),
    };
  }

  /**
   * Compose a letter, and issue it when nothing is gating it (FR-015a).
   *
   * A gated kind stops here with the letter composed and its 016 chain raised. It is
   * issued by `issue()` once the chain completes — which is why `issuedAt` is nullable
   * and why the composer offers Preview but not Issue until then.
   */
  async compose(
    caller: AuthenticatedUser,
    dto: ComposeLetterDto,
  ): Promise<IssuedLetterView> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const kind = await this.kinds.requireByKey(
      ctx,
      companyId,
      dto.letterKindKey,
    );
    this.assertMayActOnKind(caller, kind.key);
    this.assertExactlyOneSubject(dto);

    if (kind.requiresSignature && !dto.signatoryId) {
      throw new BadRequestException({
        statusCode: 400,
        message: `A ${kind.label} carries a signature, so a signatory must be named.`,
        code: SIGNATORY_REQUIRED,
      });
    }

    const template = await this.requireTemplate(
      ctx,
      companyId,
      kind.id,
      kind.label,
    );
    await this.assertTemplateIsRenderable(companyId, template.bodyTemplate);

    // Resolved before the row is written, for a kind that issues straight away: a letter
    // missing a required value is refused here rather than left behind as a composed row
    // nobody asked for. A gated kind is resolved again at `issue`, once its chain completes
    // — the records may well have moved on by then, and the letter should say what is
    // true on the day it goes out.
    const gated = Boolean(kind.requiresApproval && kind.approvalActionType);
    // Resolved for a gated kind too (2026-10-14) — not to render, but so a missing required
    // value is refused now, while the person who knows it is at the form, rather than at issue
    // after an approver has already approved a letter that cannot be produced.
    const resolvedNow = await this.finalVariables(
      caller,
      ctx,
      companyId,
      kind.id,
      dto,
      dto.variables ?? {},
    );
    this.assertLineItemsReadable(kind.key, resolvedNow);
    const variables = gated ? {} : resolvedNow;

    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.issuedLetter.create({
        data: {
          companyId,
          letterKindId: kind.id,
          employeeId: dto.employeeId ?? null,
          candidateId: dto.candidateId ?? null,
          subjectType: dto.subjectType ?? null,
          subjectId: dto.subjectId ?? null,
          templateId: template.id,
          signatoryId: dto.signatoryId ?? null,
          composedVariables: dto.variables ?? {},
          // Composed, not issued: no rendered document yet, because a rendered draft is
          // a file indistinguishable from the real thing.
          renderedRef: '',
          issuedAt: null,
          issuedBy: caller.id,
        },
        include: { letterKind: true },
      }),
    );

    if (kind.requiresApproval && kind.approvalActionType) {
      await this.raiseApproval(caller, companyId, row, kind.approvalActionType);
      // Stops here on purpose. The chain decides whether this ever becomes a document.
      return toView(row);
    }

    return this.issueResolved(caller, companyId, ctx, row, variables);
  }

  /**
   * Render and issue a composed letter (FR-015a).
   *
   * The approval gate is 016's, called and not reimplemented: `assertMayTakeEffect`
   * answers "may this take effect?" and this service consumes the answer. Two
   * implementations of one rule is how the rule gets enforced in one place and not the
   * other, and the place it is missed is found by the money having already moved.
   */
  async issue(
    caller: AuthenticatedUser,
    letterId: string,
    variables: Record<string, string> = {},
  ): Promise<IssuedLetterView> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const letter = await this.requireLetter(ctx, companyId, letterId);
    this.assertMayActOnKind(caller, letter.letterKind.key);
    this.assertNotIssued(letter);

    // Re-read from the letter's own recipient, which is what keeps a letter composed
    // before pre-fill existed — or composed weeks ago and held in an approval chain —
    // issuable with nothing but the values HR wants to override.
    const resolved = await this.finalVariables(
      caller,
      ctx,
      companyId,
      letter.letterKindId,
      letter,
      // What was typed at compose, with anything typed now over it.
      { ...composedOf(letter.composedVariables), ...variables },
    );
    return this.issueResolved(caller, companyId, ctx, letter, resolved);
  }

  /** Issue with the final variables already resolved — shared by `compose` and `issue`. */
  private async issueResolved(
    caller: AuthenticatedUser,
    companyId: string,
    ctx: RlsCtx,
    letter: LetterRow,
    variables: Record<string, string>,
  ): Promise<IssuedLetterView> {
    this.assertNotIssued(letter);

    if (
      letter.letterKind.requiresApproval &&
      letter.letterKind.approvalActionType
    ) {
      await this.approvals.assertMayTakeEffect({
        actionType: letter.letterKind.approvalActionType,
        entityType: letter.letterKind.approvalActionType,
        entityId: letter.id,
        companyId,
      });
    }

    // Allocated before the render, because the number is printed on the document. A
    // reference assigned afterwards would be stored against a PDF that does not carry it.
    const referenceNo =
      letter.referenceNo ??
      (await this.allocateReference(ctx, companyId, letter));

    const rendered = await this.render(
      ctx,
      companyId,
      { ...letter, referenceNo },
      variables,
    );

    const updated = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.issuedLetter.update({
        where: { id: letter.id },
        data: {
          referenceNo,
          renderedRef: rendered.ref,
          appliedSignatureRef: rendered.appliedSignatureRef,
          issuedAt: new Date(),
          issuedBy: caller.id,
        },
        include: { letterKind: true },
      }),
    );

    await this.audit.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.CREATE,
      entityId: updated.id,
      changes: { kind: updated.letterKind.key, version: updated.version },
      accountId: caller.id,
      companyId,
      ipAddress: '',
    });
    return toView(updated);
  }

  /**
   * Reissue: a new version that supersedes the old one, which stays retrievable (FR-014).
   *
   * Supersede rather than overwrite, and the old file is NOT deleted. A letter that went
   * out is a fact about the world; replacing the bytes behind its id would let the
   * company assert it had always said something it did not.
   */
  async reissue(
    caller: AuthenticatedUser,
    letterId: string,
    dto: ReissueLetterDto,
  ): Promise<IssuedLetterView> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const original = await this.requireLetter(ctx, companyId, letterId);
    this.assertMayActOnKind(caller, original.letterKind.key);

    if (original.issuedAt === null) {
      throw new ConflictException({
        statusCode: 409,
        message:
          'This letter has not been issued yet, so there is nothing to supersede. ' +
          'Issue it first.',
        code: LETTER_NOT_ISSUED,
      });
    }

    const signatoryId = dto.signatoryId ?? original.signatoryId;
    // Re-resolved from the records, with the correction typed over them — so a reissue
    // after a pay revision carries the new figures without HR retyping the whole letter.
    const typed = {
      ...composedOf(original.composedVariables),
      ...(dto.variables ?? {}),
    };
    const variables = await this.finalVariables(
      caller,
      ctx,
      companyId,
      original.letterKindId,
      original,
      typed,
    );
    // **The reference does not change.** A reissue is the same letter corrected, and
    // version 2 of PRPL/HR/2026-27/0007 is what the recipient has to be able to match
    // against the copy they were sent. A new number would read as a second letter.
    //
    // The unique index is on `(companyId, referenceNo)`, so the original must give it up
    // in the same transaction as the replacement takes it — done below, where the
    // supersede already happens.
    const rendered = await this.render(
      ctx,
      companyId,
      { ...original, signatoryId, referenceNo: original.referenceNo },
      variables,
    );

    const created = await withRlsContext(this.prisma, ctx, async (tx) => {
      await tx.issuedLetter.update({
        where: { id: original.id },
        data: { isSuperseded: true, referenceNo: null },
      });
      return tx.issuedLetter.create({
        data: {
          companyId,
          letterKindId: original.letterKindId,
          employeeId: original.employeeId,
          candidateId: original.candidateId,
          subjectType: original.subjectType,
          subjectId: original.subjectId,
          templateId: original.templateId,
          signatoryId,
          composedVariables: typed,
          // Taken over from the superseded row, which released it two statements up. The
          // document that was rendered carries this number; a replacement row without it
          // would leave the reference printed on a PDF that nothing in the database
          // claims, and the letter unfindable by the number its recipient quotes.
          referenceNo: original.referenceNo,
          appliedSignatureRef: rendered.appliedSignatureRef,
          renderedRef: rendered.ref,
          version: original.version + 1,
          issuedAt: new Date(),
          issuedBy: caller.id,
        },
        include: { letterKind: true },
      });
    });

    await this.audit.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.UPDATE,
      entityId: created.id,
      changes: {
        supersedes: original.id,
        version: created.version,
        kind: created.letterKind.key,
      },
      accountId: caller.id,
      companyId,
      ipAddress: '',
    });
    return toView(created);
  }

  /** The bytes, exactly as issued (FR-013). */
  async download(
    caller: AuthenticatedUser,
    letterId: string,
  ): Promise<{ data: Buffer; view: IssuedLetterView }> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const letter = await this.requireLetter(ctx, companyId, letterId);
    this.assertMayActOnKind(caller, letter.letterKind.key);

    if (!letter.renderedRef) {
      throw new ConflictException({
        statusCode: 409,
        message:
          'This letter has been composed but not issued, so there is no document yet.',
        code: LETTER_NOT_ISSUED,
      });
    }

    const data = await this.storage.get(letter.renderedRef);
    return { data, view: toView(letter) };
  }

  /** The executed copy that comes back (FR-017, FR-018). */
  async attachCountersigned(
    caller: AuthenticatedUser,
    letterId: string,
    input: { data: Buffer; contentType: string },
  ): Promise<IssuedLetterView> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const letter = await this.requireLetter(ctx, companyId, letterId);
    this.assertMayActOnKind(caller, letter.letterKind.key);

    if (letter.issuedAt === null) {
      throw new ConflictException({
        statusCode: 409,
        message: 'An unissued letter cannot have been countersigned.',
        code: LETTER_NOT_ISSUED,
      });
    }

    const ref = await this.storage.put(
      `${LETTER_NAMESPACE}-countersigned/${companyId}`,
      input.data,
      input.contentType,
    );

    const updated = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.issuedLetter.update({
        where: { id: letter.id },
        data: { countersignedRef: ref, countersignedAt: new Date() },
        include: { letterKind: true },
      }),
    );

    // The issued copy keeps its own `renderedRef`. Two distinguishable documents, which
    // is the whole of FR-018: "we sent this" and "they signed it" are different claims.
    return toView(updated);
  }

  /**
   * Letters for one subject (FR-019) — the opaque pair, never resolved.
   *
   * Exported so project, candidate and vendor screens list their letters through this
   * method rather than querying `shared.IssuedLetter` (Principle I, T062).
   */
  async listForSubject(
    caller: AuthenticatedUser,
    query: {
      subjectType?: string;
      subjectId?: string;
      employeeId?: string;
      candidateId?: string;
      /**
       * One kind across every subject (2026-10-15) — Inventory's purchase-order list, which
       * belongs to no single vendor.
       */
      letterKindKey?: string;
      includeSuperseded?: boolean;
    },
  ): Promise<IssuedLetterView[]> {
    const companyId = this.companyOf(caller);
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.issuedLetter.findMany({
          where: {
            companyId,
            ...(query.subjectType ? { subjectType: query.subjectType } : {}),
            ...(query.subjectId ? { subjectId: query.subjectId } : {}),
            ...(query.employeeId ? { employeeId: query.employeeId } : {}),
            ...(query.candidateId ? { candidateId: query.candidateId } : {}),
            ...(query.letterKindKey
              ? { letterKind: { key: query.letterKindKey } }
              : {}),
            ...(query.includeSuperseded ? {} : { isSuperseded: false }),
          },
          include: { letterKind: true },
          orderBy: [{ createdAt: 'desc' }],
        }),
    );
    // Filtered to what this caller may see, per kind. A list that showed the existence
    // of purchase orders to somebody who may not read them leaks the thing the per-kind
    // permission exists to protect.
    return rows
      .filter((r) => this.mayActOnKind(caller, r.letterKind.key))
      .map(toView);
  }

  /**
   * A letter as it would be issued, before it is composed (2026-10-14) — what the composer's
   * Preview shows. Writes nothing: no row, no reference, no approval. A missing required value
   * prints as its label in brackets rather than refusing, because finding those is what a
   * preview is for.
   */
  async previewNew(
    caller: AuthenticatedUser,
    dto: ComposeLetterDto,
  ): Promise<Buffer> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const kind = await this.kinds.requireByKey(
      ctx,
      companyId,
      dto.letterKindKey,
    );
    this.assertMayActOnKind(caller, kind.key);
    this.assertExactlyOneSubject(dto);
    const template = await this.requireTemplate(
      ctx,
      companyId,
      kind.id,
      kind.label,
    );
    const variables = await this.finalVariables(
      caller,
      ctx,
      companyId,
      kind.id,
      dto,
      dto.variables ?? {},
      { lenient: true },
    );
    const { pdf } = await this.renderDocument(
      ctx,
      companyId,
      {
        templateId: template.id,
        letterKind: kind,
        signatoryId: dto.signatoryId ?? null,
      },
      variables,
      true,
    );
    return pdf;
  }

  /**
   * A composed letter as it would be issued — what an approver reads before deciding. Refused
   * once it is issued: the issued document is the one to read then, and it can be downloaded.
   */
  async previewComposed(
    caller: AuthenticatedUser,
    letterId: string,
  ): Promise<Buffer> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const letter = await this.requireLetter(ctx, companyId, letterId);
    this.assertMayActOnKind(caller, letter.letterKind.key);
    this.assertNotIssued(letter);
    const variables = await this.finalVariables(
      caller,
      ctx,
      companyId,
      letter.letterKindId,
      letter,
      composedOf(letter.composedVariables),
      { lenient: true },
    );
    const { pdf } = await this.renderDocument(
      ctx,
      companyId,
      letter,
      variables,
      true,
    );
    return pdf;
  }

  /**
   * Attaches each gated letter's approval state for this caller — one read per approval action,
   * not one per letter (`statesOf` exists to avoid exactly that N+1).
   */
  async withApprovals(
    caller: AuthenticatedUser,
    views: IssuedLetterView[],
  ): Promise<IssuedLetterView[]> {
    const kinds = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.letterKind.findMany({
          where: { id: { in: [...new Set(views.map((v) => v.letterKindId))] } },
          select: { id: true, approvalActionType: true },
        }),
    );
    const actionOf = new Map(kinds.map((k) => [k.id, k.approvalActionType]));
    const byAction = new Map<string, string[]>();
    for (const view of views) {
      const action = actionOf.get(view.letterKindId);
      if (!view.requiresApproval || !action) continue;
      byAction.set(action, [...(byAction.get(action) ?? []), view.id]);
    }
    const states = new Map<string, ApprovalInstanceView>();
    for (const [action, ids] of byAction) {
      // A letter's instance is raised with the action as its entity type — see `raiseApproval`.
      for (const [id, state] of await this.approvals.statesOf(
        action,
        ids,
        caller,
      )) {
        states.set(id, state);
      }
    }
    return views.map((view) => ({
      ...view,
      approval: states.get(view.id) ?? null,
    }));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * The values a letter is rendered with: the records first, anything HR typed over them.
   *
   * A non-empty supplied value wins over the record for the same token — that is the
   * "HR may override any of them" half of pre-fill — and an empty one does not, so a form
   * submitted with a field cleared falls back to the record rather than printing a blank.
   * The overridden fields are resolved as `manual`, which is what they now are: typed.
   *
   * `resolve()` then refuses a required field nobody could supply, with
   * `LETTER_REQUIRED_FIELD_UNRESOLVED` naming it.
   *
   * Supplied values for tokens the kind does not declare are passed through untouched. A
   * kind with no declared fields — a work order defined before field declarations existed
   * — renders from `variables` exactly as it always did.
   */
  private async finalVariables(
    caller: AuthenticatedUser,
    ctx: RlsCtx,
    companyId: string,
    letterKindId: string,
    recipient: LetterRecipient,
    supplied: Record<string, string>,
    options: { lenient?: boolean } = {},
  ): Promise<Record<string, string>> {
    const declared = await this.fields.fieldsFor(ctx, companyId, letterKindId);
    if (declared.length === 0) return { ...supplied };

    const records = await this.recordsFor(caller, ctx, companyId, recipient);
    const typed = (token: string) =>
      typeof supplied[token] === 'string' && supplied[token].trim() !== '';
    const asResolved: LetterFieldView[] = declared.map((field) =>
      typed(field.token)
        ? { ...field, sourceType: LetterFieldSource.manual, sourcePath: null }
        : field,
    );
    const resolved = this.fields.resolve(
      asResolved,
      records,
      supplied,
      options,
    );
    return { ...supplied, ...resolved };
  }

  /**
   * The records a letter's fields read: its recipient, through whichever business module
   * registered for it, and the company, read here.
   *
   * The company is a `settings` row and this module already reads it for the letterhead
   * and the reference prefix; it needs no registry. The registered address is joined into
   * one line, the way a letter prints it.
   */
  private async recordsFor(
    caller: AuthenticatedUser,
    ctx: RlsCtx,
    companyId: string,
    recipient: LetterRecipient,
  ): Promise<Partial<Record<LetterFieldSource, Record<string, unknown>>>> {
    const [employee, candidate, project, company] = await Promise.all([
      recipient.employeeId
        ? this.records.resolve(caller, 'employee', recipient.employeeId)
        : null,
      recipient.candidateId
        ? this.records.resolve(caller, 'candidate', recipient.candidateId)
        : null,
      recipient.subjectType === 'project' && recipient.subjectId
        ? this.records.resolve(caller, 'project', recipient.subjectId)
        : null,
      withRlsContext(this.prisma, ctx, async (tx) => {
        const row = await tx.company.findUnique({
          where: { id: companyId },
          select: {
            name: true,
            shortCode: true,
            address: true,
            city: true,
            state: true,
            pinCode: true,
            gstin: true,
            pan: true,
            phone: true,
            email: true,
          },
        });
        if (!row) return null;
        // The company's standard terms for each commercial document, as Settings holds them
        // (2026-10-14). They were set there and printed nowhere: a work order, LOI or PO went
        // out with none of the clauses the company had written. Read here so a letter's
        // `terms.workOrder` field reaches them; Settings falls back to the shipped set.
        const [workOrder, letterOfIntent, purchaseOrder] = await Promise.all([
          this.terms.bodyFor(tx, companyId, TermsDocumentKind.work_order),
          this.terms.bodyFor(tx, companyId, TermsDocumentKind.letter_of_intent),
          this.terms.bodyFor(tx, companyId, TermsDocumentKind.purchase_order),
        ]);
        return { ...row, terms: { workOrder, letterOfIntent, purchaseOrder } };
      }),
    ]);

    const records: Partial<Record<LetterFieldSource, Record<string, unknown>>> =
      {};
    if (employee) records.employee = employee;
    if (candidate) records.candidate = candidate;
    if (project) records.project = project;
    if (company) {
      const place = [company.address, company.city, company.state]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join(', ');
      records.company = {
        terms: company.terms,
        name: company.name,
        shortCode: company.shortCode,
        gstin: company.gstin,
        pan: company.pan,
        phone: company.phone,
        email: company.email,
        address: company.pinCode
          ? `${place}${place ? ' - ' : ''}${company.pinCode}`
          : place,
      };
    }
    return records;
  }

  private assertNotIssued(letter: { issuedAt: Date | null }): void {
    if (letter.issuedAt === null) return;
    throw new ConflictException({
      statusCode: 409,
      message:
        'This letter has already been issued. Correcting an issued letter is a ' +
        'reissue, which supersedes it and keeps both versions retrievable.',
      code: LETTER_ALREADY_ISSUED,
    });
  }

  private async render(
    ctx: ReturnType<typeof rlsContextFor>,
    companyId: string,
    letter: {
      templateId: string;
      letterKind: { key: string; label: string; requiresSignature: boolean };
      signatoryId: string | null;
      referenceNo?: string | null;
    },
    variables: Record<string, string>,
  ): Promise<{ ref: string; appliedSignatureRef: string | null }> {
    const { pdf, appliedSignatureRef } = await this.renderDocument(
      ctx,
      companyId,
      letter,
      variables,
      false,
    );
    const ref = await this.storage.put(
      `${LETTER_NAMESPACE}/${companyId}`,
      pdf,
      'application/pdf',
    );
    return { ref, appliedSignatureRef };
  }

  /**
   * Refuses item lines that cannot be read, naming the line (2026-10-14). Checked at compose so
   * the person typing them hears about it — not the approver, at issue, of a work order that
   * cannot be produced.
   */
  private assertLineItemsReadable(
    kindKey: string,
    variables: Record<string, string>,
  ): void {
    try {
      expandLineItems(kindKey, variables);
    } catch (error) {
      if (error instanceof LineItemsError) {
        throw new BadRequestException({
          statusCode: 400,
          message: error.message,
          code: LETTER_LINE_ITEMS_UNREADABLE,
        });
      }
      throw error;
    }
  }

  /**
   * The document, rendered and not stored. `draft` is a preview's: marked DRAFT on every page,
   * no reference, and the signatory named but their graphic left off — see `LetterSignature`.
   */
  private async renderDocument(
    ctx: ReturnType<typeof rlsContextFor>,
    companyId: string,
    letter: {
      templateId: string;
      letterKind: { key: string; label: string; requiresSignature: boolean };
      signatoryId: string | null;
      referenceNo?: string | null;
    },
    variables: Record<string, string>,
    draft: boolean,
  ): Promise<{ pdf: Buffer; appliedSignatureRef: string | null }> {
    const [template, company] = await withRlsContext(this.prisma, ctx, (tx) =>
      Promise.all([
        tx.letterTemplate.findFirst({
          where: { id: letter.templateId, companyId },
        }),
        tx.company.findUnique({
          where: { id: companyId },
          select: {
            letterheadRef: true,
            logoRef: true,
            name: true,
            address: true,
            city: true,
            state: true,
            pinCode: true,
            phone: true,
            email: true,
            website: true,
          },
        }),
      ]),
    );
    if (!template) {
      throw new ConflictException({
        statusCode: 409,
        message: 'The template this letter was composed from no longer exists.',
        code: LETTER_TEMPLATE_MISSING,
      });
    }
    await this.assertTemplateIsRenderable(companyId, template.bodyTemplate);

    let signature: { image: Buffer; name: string; title: string } | undefined;
    let appliedSignatureRef: string | null = null;
    if (letter.letterKind.requiresSignature && letter.signatoryId) {
      const signatory = await this.signatories.requireById(
        ctx,
        companyId,
        letter.signatoryId,
      );
      // BOTH the id and the graphic (research §5). Storing only the id would re-render
      // this letter with whatever image the signatory has *today* — FR-013 says a
      // previously issued letter renders as it was issued, and a signature that silently
      // changes is the one thing a signature may never do.
      appliedSignatureRef = draft ? null : signatory.signatureRef;
      signature = {
        image: draft ? null : await this.storage.get(signatory.signatureRef),
        name: signatory.name,
        title: signatory.title,
      };
    }

    // The date in the body is the date on the letter — the same clock as the header below, so
    // "Issued on" and the printed date cannot disagree. A body could reference `issueDate` and
    // nothing ever supplied it, which printed "Issued on ." on every work order.
    // The item table and the totals worked out from it, for the kinds that print one. A
    // preview with unreadable lines says so where the table goes; an issue cannot get here
    // with them, because compose refused them.
    let derived: Record<string, string> = {};
    try {
      derived = expandLineItems(letter.letterKind.key, variables);
    } catch (error) {
      if (!(draft && error instanceof LineItemsError)) throw error;
      derived = { lineItemsTable: `[Items: ${error.message}]` };
    }
    const issueDate = formatLetterDate(new Date());
    const layout = LETTER_LAYOUTS[letter.letterKind.key];

    // The date in the body is the date on the letter — the same clock as the header below, so
    // "Issued on" and the printed date cannot disagree. A body could reference `issueDate` and
    // nothing ever supplied it, which printed "Issued on ." on every work order. The reference
    // likewise: a purchase order quotes its own number in its body.
    const body = renderTemplate(template.bodyTemplate, {
      issueDate,
      referenceNo: draft ? '(assigned on issue)' : letter.referenceNo ?? '',
      ...variables,
      ...derived,
    });
    const pdf = await renderLetterPdf({
      title: layout?.title ?? letter.letterKind.label.toUpperCase(),
      body,
      letterhead: layout?.brandHeader
        ? null
        : await this.letterhead(template.letterheadAssetId, company),
      brandHeader: layout?.brandHeader
        ? await this.brandHeader(company)
        : undefined,
      pageFooter: layout?.pageFooter?.(variables),
      referenceLabel: layout?.referenceLabel,
      referenceNo: draft ? null : letter.referenceNo ?? null,
      // The date the letter bears is the day it is issued. Taken from the clock rather
      // than from `variables`, so the printed date and `issuedAt` can never disagree —
      // which, on a document that starts a notice period, is a dispute.
      issueDate,
      signature,
      draft,
    });
    return { pdf, appliedSignatureRef };
  }

  /**
   * The next reference for this company's series (2026-10-11).
   *
   * `HR` is in the prefix only for a letter addressed to a person — an employee or a
   * candidate — so an award to a subcontractor is not filed under HR. The company's short
   * code and the financial year come from the company row and the clock; see
   * `letter-reference.ts` for why the series resets itself each April without a job.
   *
   * The existing references are read under the same prefix rather than all of them: a
   * company that has been issuing letters for five years has five years of rows, and only
   * this year's share a series.
   */
  private async allocateReference(
    ctx: ReturnType<typeof rlsContextFor>,
    companyId: string,
    letter: { employeeId: string | null; candidateId: string | null },
  ): Promise<string> {
    const forAPerson = Boolean(letter.employeeId ?? letter.candidateId);
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const company = await tx.company.findUnique({
        where: { id: companyId },
        select: { shortCode: true },
      });
      // `LTR` only if the company row has vanished under us, which RLS makes almost
      // impossible here. A letter with an odd prefix beats an issue that throws.
      const prefix = referencePrefix(
        company?.shortCode ?? 'LTR',
        forAPerson,
        new Date(),
      );
      const existing = await tx.issuedLetter.findMany({
        where: { companyId, referenceNo: { startsWith: prefix } },
        select: { referenceNo: true },
      });
      return nextReference(
        prefix,
        existing.map((row) => row.referenceNo ?? ''),
      );
    });
  }

  /**
   * The logo-and-name band a work order or purchase order opens with (2026-10-14): the logo,
   * the company name, and the registered office with whichever of phone, email and website
   * Settings holds. A logo that cannot be read prints the name alone.
   */
  private async brandHeader(
    company: {
      name: string;
      logoRef: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      pinCode: string | null;
      phone: string | null;
      email: string | null;
      website: string | null;
    } | null,
  ): Promise<BrandHeader> {
    if (!company) return { logo: null, name: '', lines: [] };
    const place = [company.address, company.city, company.state]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(', ');
    const office = company.pinCode ? `${place} - ${company.pinCode}` : place;
    const contact = [
      company.phone ? `Ph: ${company.phone}` : null,
      company.email ? `Email: ${company.email}` : null,
    ]
      .filter(Boolean)
      .join('  |  ');
    let logo: Buffer | null = null;
    if (company.logoRef) {
      try {
        logo = await this.storage.get(company.logoRef);
      } catch {
        this.logger.warn(
          `Logo ${company.logoRef} could not be read; printing the name alone.`,
        );
      }
    }
    return {
      logo,
      name: company.name ?? '',
      lines: [
        office ? `Registered Office: ${office}` : '',
        contact,
        company.website ? `Website: ${company.website}` : '',
      ].filter(Boolean),
    };
  }

  /**
   * The stationery to print on: the template's own, else the company's, else none.
   *
   * `LetterTemplate.letterheadAssetId` has existed since the 017 restructure and was never
   * read by anything — the column was written at save and ignored at render. It is honoured
   * here rather than removed, because a company with one letterhead for HR and another for
   * commercial letters is the case it was added for, and the per-company reference is the
   * answer for everyone else.
   *
   * A reference that no longer resolves returns null rather than throwing. Losing the
   * artwork must not make a company's letters unissuable; it makes them plain.
   */
  private async letterhead(
    templateRef: string | null,
    company: { letterheadRef: string | null } | null,
  ): Promise<Buffer | null> {
    const ref = templateRef ?? company?.letterheadRef ?? null;
    if (!ref) return null;
    try {
      return await this.storage.get(ref);
    } catch {
      this.logger.warn(
        `Letterhead ${ref} could not be read; rendering on plain paper.`,
      );
      return null;
    }
  }

  /**
   * FR-024, enforced on every render rather than only at template save.
   *
   * Checked here as well as at save because `isRestricted` can be switched on *after* a
   * template was written. A rule enforced only at save would let an existing template
   * keep rendering the thing that just became regulated.
   */
  private async assertTemplateIsRenderable(
    companyId: string,
    body: string,
  ): Promise<void> {
    const types = await this.documentTypes.listForCompany(companyId);
    assertNoRestrictedTypes(body, types);
  }

  private async requireTemplate(
    ctx: ReturnType<typeof rlsContextFor>,
    companyId: string,
    letterKindId: string,
    kindLabel: string,
  ) {
    const template = await withRlsContext(this.prisma, ctx, (tx) =>
      this.templates.getActive(companyId, letterKindId, tx),
    );
    if (!template) {
      throw new ConflictException({
        statusCode: 409,
        message: `No active ${kindLabel} template exists. Create one first.`,
        code: LETTER_TEMPLATE_MISSING,
      });
    }
    return template;
  }

  private async requireLetter(
    ctx: ReturnType<typeof rlsContextFor>,
    companyId: string,
    id: string,
  ): Promise<LetterRow> {
    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.issuedLetter.findFirst({
        where: { id, companyId },
        include: { letterKind: true },
      }),
    );
    if (!row) throw new NotFoundException(`Letter ${id} not found.`);
    return row;
  }

  private async raiseApproval(
    caller: AuthenticatedUser,
    companyId: string,
    letter: LetterRow,
    actionType: string,
  ): Promise<void> {
    const subject =
      `${letter.letterKind.label} — ` +
      (letter.subjectId
        ? `${letter.subjectType ?? 'subject'} ${letter.subjectId}`
        : letter.employeeId ?? letter.candidateId ?? 'unaddressed');

    try {
      await this.approvals.submit({
        companyId,
        actionType,
        entityType: actionType,
        entityId: letter.id,
        originatorUserId: caller.id,
        subject,
        // Two different pages list letters, and which one depends on what the letter is
        // addressed to: a project's letters are filtered by `subjectType: 'project'` on the
        // project's own tab, everything else is listed under Recruitment. Neither has a page
        // per letter, so both land on the list that contains it. `/dashboard/letters/:id`,
        // which this was, is a page that exists in neither place.
        // A purchase order addressed to a vendor is listed on Inventory's purchase-order page
        // (2026-10-15); one raised on a project before that keeps its project tab.
        href:
          letter.subjectType === 'project' && letter.subjectId
            ? webRoutes.projectLetters(letter.subjectId)
            : letter.letterKind.key === ACTION_LETTER_PURCHASE_ORDER
            ? webRoutes.inventoryPurchaseOrders()
            : webRoutes.recruitmentLetters(),
        viewPermission: permissionForKind(letter.letterKind.key),
      });
    } catch (error) {
      // The letter stays composed and unissued, which is the safe state: it cannot take
      // effect without a completed chain, and `issue()` refuses it. Logged because the
      // person who hits the refusal is not the person who can configure the chain.
      this.logger.error(
        `Letter ${letter.id} (${letter.letterKind.key}) was composed but could not ` +
          `enter an approval chain: ${
            error instanceof Error ? error.message : String(error)
          }. It cannot be issued until this is fixed.`,
      );
      throw error;
    }
  }

  private assertExactlyOneSubject(dto: ComposeLetterDto): void {
    const person = Boolean(dto.employeeId || dto.candidateId);
    const opaque = Boolean(dto.subjectType && dto.subjectId);
    if (person === opaque) {
      throw new BadRequestException(
        person
          ? 'A letter addresses a person or a subject, not both — "who is this letter ' +
            'for?" must have one answer.'
          : 'A letter must address an employee, a candidate, or a subjectType/subjectId pair.',
      );
    }
    if (Boolean(dto.subjectType) !== Boolean(dto.subjectId)) {
      throw new BadRequestException(
        'subjectType and subjectId are meaningless apart; supply both or neither.',
      );
    }
  }

  private mayActOnKind(caller: AuthenticatedUser, key: string): boolean {
    return caller.permissions.includes(permissionForKind(key));
  }

  private assertMayActOnKind(caller: AuthenticatedUser, key: string): void {
    if (this.mayActOnKind(caller, key)) return;
    throw new ForbiddenException({
      statusCode: 403,
      message:
        `Your roles do not carry the permission a "${key}" letter requires. There is no ` +
        `single letters permission: a work order and a relieving letter are not the ` +
        `same authority.`,
      code: LETTER_KIND_FORBIDDEN,
    });
  }

  private companyOf(caller: AuthenticatedUser): string {
    if (!caller.companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return caller.companyId;
  }
}
