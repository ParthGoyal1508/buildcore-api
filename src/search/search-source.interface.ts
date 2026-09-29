import { Permission } from '@prisma/client';

import { RlsContext } from '../common/prisma/rls-context';
import { SearchResult } from './dto/search-result.dto';

/** The four registers search spans. Also the `register` value on every result. */
export type SearchRegister = 'employee' | 'vendor' | 'equipment' | 'project';

/**
 * One register's contribution to cross-register search (021 FR-001, FR-001a).
 *
 * Implemented **inside the owning module** — `src/hr/employees/`,
 * `src/partners/vendors/`, `src/plant/equipment/`, `src/projects/portfolio/` — and
 * registered with `SearchSourcesRegistry` on module init. `src/search/` holds the
 * registry and queries nothing itself, because `Employee`, `Vendor`, `Equipment` and
 * `Project` live in four different schemas and Principle I forbids one query spanning
 * them.
 */
export interface SearchSource {
  /** Stable key, also the `register` value on every result this source returns. */
  readonly register: SearchRegister;

  /**
   * The permission this register requires.
   *
   * `SearchSourcesRegistry` checks it **before** calling `search`, and a caller without
   * it gets an empty contribution — never an entry in `unavailableSources`, which would
   * disclose that the register exists (021 FR-002).
   */
  readonly permission: Permission;

  /**
   * Match `term` against this register's code (prefix) and name (substring).
   *
   * `ctx` and `companyId` are **parameters, not something the implementation chooses**.
   * A source that resolved its own scope could widen it, and the widening would live
   * inside a closure where review cannot see it; passed in, an implementation that
   * ignores them is visible in the diff.
   *
   * `limit` is passed in for the same reason: four implementations reading a cap from
   * configuration independently is four chances to disagree about it.
   */
  search(
    ctx: RlsContext,
    companyId: string,
    term: string,
    limit: number,
  ): Promise<SearchResult[]>;
}
