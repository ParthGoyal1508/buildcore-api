import { Injectable, Logger } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { RlsContext } from '../common/prisma/rls-context';
import { SearchResponse, SearchResult } from './dto/search-result.dto';
import { SearchSource } from './search-source.interface';

/**
 * Where each register announces that it can be searched (021 US1).
 *
 * The same shape as `ProjectSourcesRegistry`, and for the same reason: the four registers
 * are in four schemas, so one query cannot span them (Principle I), and a module that
 * imported all four would either be a dependency cycle or a boundary violation. Each
 * owning module injects this registry and registers itself on init; this class merges
 * whatever turned up and queries nothing.
 *
 * > **`unavailableSources` must never carry a permission failure.** The field is
 * > inherited from the project registry, where it means "we could not ask". Using it for
 * > "you may not see this register" would disclose the existence of exactly what
 * > 021 FR-002 forbids disclosing. A caller who lacks a register's permission gets an
 * > empty contribution and no mention of it anywhere in the response —
 * > indistinguishable from a genuine miss. The field's name invites the mistake, which is
 * > why the warning is here, in the data model, and in the plan.
 */
@Injectable()
export class SearchSourcesRegistry {
  private readonly logger = new Logger(SearchSourcesRegistry.name);

  private readonly sources = new Map<string, SearchSource>();

  register(source: SearchSource): void {
    if (this.sources.has(source.register)) {
      // Two sources for one register means one is shadowing the other and a quarter of
      // every search is silently coming from somewhere nobody expects. Loud, because the
      // symptom otherwise is results that are merely incomplete.
      this.logger.warn(
        `A search source for "${source.register}" is already registered; the second registration is ignored.`,
      );
      return;
    }
    this.sources.set(source.register, source);
  }

  /** Which registers this deployment can search at all. Used by the boundary spec. */
  registeredRegisters(): string[] {
    return [...this.sources.keys()];
  }

  /**
   * Fan out to every registered source the caller may use, in parallel, and merge.
   *
   * Parallel is the performance claim NFR-001 rests on — four queries cost about the
   * slowest rather than their sum. A source that throws is caught and named in
   * `unavailableSources`: one register being down must not fail the whole search.
   */
  async searchAll(
    caller: AuthenticatedUser,
    ctx: RlsContext,
    companyId: string,
    term: string,
    limits: { perRegister: number; total: number },
  ): Promise<SearchResponse> {
    const unavailableSources: string[] = [];

    // The permission is checked HERE, before the source is called — never by filtering a
    // merged list afterwards. A gather-then-filter leaks through result counts and
    // through timing, and it puts the obligation to remember filtering on every register
    // added later rather than on this one place (FR-001c).
    const permitted = [...this.sources.values()].filter((source) =>
      caller.permissions.includes(source.permission),
    );

    // One more than the cap, deliberately. A source given `take: 10` that returns exactly
    // 10 rows cannot tell the registry whether that was all of them or the first ten of
    // hundreds — so asking for 11 and receiving 11 *is* the signal, and the extra row is
    // discarded. This costs one row per register and needs no change to `SearchSource`.
    //
    // Found by the e2e: with 36 matching projects and a per-register cap of 10, the
    // merged list was 13 rows against a total cap of 30, so `truncated` read **false**
    // while 26 matches were being withheld. That is precisely the silence the spec's
    // "a search that would match thousands" edge case exists to prevent.
    let perRegisterTruncated = false;

    const settled = await Promise.all(
      permitted.map(async (source) => {
        try {
          const rows = await source.search(
            ctx,
            companyId,
            term,
            limits.perRegister + 1,
          );
          if (rows.length > limits.perRegister) {
            perRegisterTruncated = true;
            return rows.slice(0, limits.perRegister);
          }
          return rows;
        } catch (error) {
          // "We could not ask" — the honest meaning of the field. A register being down
          // is worth telling the caller about; a register they may not see is not.
          this.logger.warn(
            `Search source "${source.register}" failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          unavailableSources.push(source.register);
          return [] as SearchResult[];
        }
      }),
    );

    const merged = rankResults(settled.flat(), term);

    // Truncation is decided after ranking, so an exact code match is never the row that
    // gets cut (FR-001b).
    const overTotal = merged.length > limits.total;

    return {
      results: overTotal ? merged.slice(0, limits.total) : merged,
      // Either cap counts. A response that admitted only the merged cap would report
      // `false` while a single register was withholding most of its matches.
      truncated: overTotal || perRegisterTruncated,
      unavailableSources,
    };
  }
}

/**
 * Two tiers: records whose code matches the term exactly, then everything else. Within a
 * tier the order each source returned is preserved.
 *
 * Deliberately **not** a relevance score. A weighted function across four heterogeneous
 * registers gets tuned forever and cannot be tested against anything, and the client's
 * 2026-09-16 clarification declined to specify ordering beyond this single rule. One rule
 * that can be asserted beats five that can only be argued about.
 */
export function rankResults(
  results: SearchResult[],
  term: string,
): SearchResult[] {
  const needle = term.trim().toLowerCase();
  const exact: SearchResult[] = [];
  const rest: SearchResult[] = [];
  for (const result of results) {
    if (result.code.toLowerCase() === needle) {
      exact.push(result);
    } else {
      rest.push(result);
    }
  }
  return [...exact, ...rest];
}
