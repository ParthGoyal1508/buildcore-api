import { Injectable, Logger } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/authenticated-user';

/** The record kinds a business module can answer for. `company` is read inside letters. */
export type LetterRecordSourceType = 'employee' | 'candidate';

/**
 * Reads one record for a letter, as a plain object `LetterKindField.sourcePath` is resolved
 * against. Null when the id names nothing the caller may see.
 *
 * Values may be strings, numbers, `Date`s or `Prisma.Decimal`s — `LetterKindFieldsService`
 * formats them — nested at most one level (`revision.ctc`), because a dot path is all a
 * declared field can express.
 */
export type LetterRecordResolver = (
  caller: AuthenticatedUser,
  id: string,
) => Promise<Record<string, unknown> | null>;

/**
 * Where business modules announce the records a letter can be pre-filled from (2026-10-13).
 *
 * ## Why a registry rather than an import
 *
 * `letters-boundary.spec.ts` forbids `src/letters/` from querying a business schema, and
 * the module from importing a business module: a letter addresses its recipient by id and
 * never learns what an employee *is*. That was right, and it left the declared fields with
 * nothing to read — `LetterKindFieldsService.resolve()` had no caller, so every letter was
 * typed out by hand from records the system already held.
 *
 * So the dependency points the other way, as `ProjectSourcesRegistry` does for a project
 * page: `hr` and `recruitment` import this module and register a resolver on init, and the
 * letters service reads whatever turned up. It never knows who answered.
 *
 * ## Several contributors per record, merged
 *
 * Unlike the project registry, a second registration is **not** ignored. One employee
 * record is assembled by two modules that cannot import each other: `hr` knows the
 * employee, the pay and the exit; `recruitment` knows the resignation, and already imports
 * `hr`, so `hr` asking it would close a cycle. Each contributes its own top-level keys and
 * the results are merged — one level deep, so `hr`'s `fnf.net` and `recruitment`'s
 * `fnf.noticeRequiredDays` end up in the same `fnf` object.
 *
 * A contributor that throws is logged and skipped. A letter missing the resignation date
 * is a form with one blank for HR to fill; a letter that cannot be opened because the
 * resignations table hiccupped is a support call.
 *
 * Nothing registered is not an error either: every field then pre-fills empty, which is
 * what the form showed before this existed.
 */
@Injectable()
export class LetterRecordSources {
  private readonly logger = new Logger(LetterRecordSources.name);
  private readonly resolvers = new Map<
    LetterRecordSourceType,
    LetterRecordResolver[]
  >();

  register(
    source: LetterRecordSourceType,
    resolver: LetterRecordResolver,
  ): void {
    const list = this.resolvers.get(source) ?? [];
    list.push(resolver);
    this.resolvers.set(source, list);
  }

  /** Whether anything answers for this record kind. */
  has(source: LetterRecordSourceType): boolean {
    return (this.resolvers.get(source)?.length ?? 0) > 0;
  }

  /**
   * The merged record, or null when no contributor recognised the id.
   *
   * Contributors run in parallel; they read different tables and none depends on another.
   */
  async resolve(
    caller: AuthenticatedUser,
    source: LetterRecordSourceType,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const list = this.resolvers.get(source) ?? [];
    if (list.length === 0) return null;

    const parts = await Promise.all(
      list.map(async (resolver) => {
        try {
          return await resolver(caller, id);
        } catch (error) {
          this.logger.warn(
            `A ${source} record contributor failed for ${id}; its fields are left for ` +
              `HR to type: ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
          return null;
        }
      }),
    );

    const present = parts.filter(
      (part): part is Record<string, unknown> => part !== null,
    );
    if (present.length === 0) return null;
    return present.reduce(mergeOneLevel, {});
  }
}

/** Plain nested objects are merged; anything else (a Date, a Decimal) is replaced whole. */
function mergeOneLevel(
  into: Record<string, unknown>,
  from: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(from)) {
    const existing = into[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      into[key] = { ...existing, ...value };
    } else if (value !== undefined) {
      into[key] = value;
    }
  }
  return into;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
