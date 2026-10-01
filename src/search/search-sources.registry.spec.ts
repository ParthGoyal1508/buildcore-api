import { Permission } from '@prisma/client';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { RlsContext } from '../common/prisma/rls-context';
import { SearchResult } from './dto/search-result.dto';
import { SearchRegister, SearchSource } from './search-source.interface';
import { SearchSourcesRegistry, rankResults } from './search-sources.registry';

/** A source that records how it was called, so the registry's contract can be asserted. */
class FakeSource implements SearchSource {
  calls: { companyId: string; term: string; limit: number }[] = [];

  constructor(
    readonly register: SearchRegister,
    readonly permission: Permission,
    private readonly rows: SearchResult[],
    private readonly throws = false,
  ) {}

  async search(
    _ctx: RlsContext,
    companyId: string,
    term: string,
    limit: number,
  ): Promise<SearchResult[]> {
    this.calls.push({ companyId, term, limit });
    if (this.throws) {
      throw new Error('register is down');
    }
    return this.rows;
  }
}

const result = (
  register: SearchRegister,
  code: string,
  label: string,
  matchedOn: 'code' | 'name' = 'name',
): SearchResult => ({
  register,
  id: `${register}-${code}`,
  code,
  label,
  sublabel: null,
  matchedOn,
  href: `/${register}/${code}`,
});

const caller = (permissions: Permission[]): AuthenticatedUser =>
  ({ id: 'u1', companyId: 'c1', permissions } as AuthenticatedUser);

const ctx: RlsContext = { isSuperAdmin: false, companyId: 'c1' };
const limits = { perRegister: 10, total: 30 };

describe('SearchSourcesRegistry', () => {
  it('fans out to every source the caller may use', async () => {
    const registry = new SearchSourcesRegistry();
    const projects = new FakeSource('project', Permission.PROJECTS, [
      result('project', 'PRJ-014', 'Parth Tirupati Phase II'),
    ]);
    const vendors = new FakeSource('vendor', Permission.PARTNERS, [
      result('vendor', 'TIRU', 'Tirupati Traders'),
    ]);
    registry.register(projects);
    registry.register(vendors);

    const response = await registry.searchAll(
      caller([Permission.PROJECTS, Permission.PARTNERS]),
      ctx,
      'c1',
      'Tirupati',
      limits,
    );

    expect(response.results).toHaveLength(2);
    expect(response.unavailableSources).toEqual([]);
    expect(response.truncated).toBe(false);
  });

  it('passes companyId, term and limit through to each source', async () => {
    // The interface takes these as parameters precisely so a source cannot choose its own
    // scope. If the registry stopped passing them, an implementation reading its own would
    // be the only thing still working — and it would be the one that could widen scope.
    const registry = new SearchSourcesRegistry();
    const projects = new FakeSource('project', Permission.PROJECTS, []);
    registry.register(projects);

    await registry.searchAll(caller([Permission.PROJECTS]), ctx, 'c9', 'abc', {
      perRegister: 4,
      total: 8,
    });

    // `limit: 5`, one more than the cap: a source returning exactly the cap cannot say
    // whether that was all of them, so the extra row is the signal and is discarded.
    expect(projects.calls).toEqual([
      { companyId: 'c9', term: 'abc', limit: 5 },
    ]);
  });

  it('never calls a source the caller lacks permission for', async () => {
    // Checked before the call, not by filtering afterwards: a gather-then-filter leaks
    // through counts and through timing (FR-001c).
    const registry = new SearchSourcesRegistry();
    const employees = new FakeSource('employee', Permission.EMPLOYEES, [
      result('employee', 'EMP-1', 'Ramesh Kumar'),
    ]);
    registry.register(employees);

    const response = await registry.searchAll(
      caller([Permission.PROJECTS]),
      ctx,
      'c1',
      'Ramesh',
      limits,
    );

    expect(employees.calls).toEqual([]);
    expect(response.results).toEqual([]);
  });

  it('does NOT name a permission-denied register in unavailableSources', async () => {
    // The disclosure this whole design is arranged to avoid. `unavailableSources` means
    // "we could not ask"; using it for "you may not see this" tells the caller the
    // register exists, which FR-002 forbids. The field name invites the mistake, so this
    // is asserted rather than assumed.
    const registry = new SearchSourcesRegistry();
    registry.register(
      new FakeSource('employee', Permission.EMPLOYEES, [
        result('employee', 'EMP-1', 'Ramesh Kumar'),
      ]),
    );

    const denied = await registry.searchAll(
      caller([]),
      ctx,
      'c1',
      'Ramesh',
      limits,
    );

    expect(denied.unavailableSources).toEqual([]);
    // Byte-identical to a search of an empty register by a permitted caller.
    const emptyRegistry = new SearchSourcesRegistry();
    emptyRegistry.register(
      new FakeSource('employee', Permission.EMPLOYEES, []),
    );
    const miss = await emptyRegistry.searchAll(
      caller([Permission.EMPLOYEES]),
      ctx,
      'c1',
      'Ramesh',
      limits,
    );
    expect(denied).toEqual(miss);
  });

  it('catches a throwing source and keeps the rest of the search', async () => {
    const registry = new SearchSourcesRegistry();
    registry.register(
      new FakeSource('plant' as SearchRegister, Permission.MACHINERY, [], true),
    );
    registry.register(
      new FakeSource('project', Permission.PROJECTS, [
        result('project', 'PRJ-014', 'Parth Tirupati Phase II'),
      ]),
    );

    const response = await registry.searchAll(
      caller([Permission.MACHINERY, Permission.PROJECTS]),
      ctx,
      'c1',
      'Tirupati',
      limits,
    );

    expect(response.results).toHaveLength(1);
    expect(response.unavailableSources).toEqual(['plant']);
  });

  it('ignores a second source for the same register', async () => {
    const registry = new SearchSourcesRegistry();
    registry.register(new FakeSource('project', Permission.PROJECTS, []));
    registry.register(new FakeSource('project', Permission.PROJECTS, []));
    expect(registry.registeredRegisters()).toEqual(['project']);
  });

  it('reports truncation when a single register hits its own cap', async () => {
    // The bug the e2e found: with a per-register cap of 10 and 36 matching projects, the
    // merged list was well under the total cap, so `truncated` read false while most of
    // the matches were being withheld.
    const registry = new SearchSourcesRegistry();
    registry.register(
      new FakeSource(
        'project',
        Permission.PROJECTS,
        Array.from({ length: 11 }, (_unused, i) =>
          result('project', `PRJ-${i}`, `Site ${i}`),
        ),
      ),
    );

    const response = await registry.searchAll(
      caller([Permission.PROJECTS]),
      ctx,
      'c1',
      'Site',
      { perRegister: 10, total: 30 },
    );

    expect(response.results).toHaveLength(10);
    expect(response.truncated).toBe(true);
  });

  it('does not report truncation when a register returns exactly what it had', async () => {
    const registry = new SearchSourcesRegistry();
    registry.register(
      new FakeSource(
        'project',
        Permission.PROJECTS,
        Array.from({ length: 10 }, (_unused, i) =>
          result('project', `PRJ-${i}`, `Site ${i}`),
        ),
      ),
    );

    const response = await registry.searchAll(
      caller([Permission.PROJECTS]),
      ctx,
      'c1',
      'Site',
      { perRegister: 10, total: 30 },
    );

    expect(response.results).toHaveLength(10);
    expect(response.truncated).toBe(false);
  });

  it('caps the merged list and says so', async () => {
    const registry = new SearchSourcesRegistry();
    registry.register(
      new FakeSource(
        'project',
        Permission.PROJECTS,
        Array.from({ length: 5 }, (_unused, i) =>
          result('project', `PRJ-${i}`, `Site ${i}`),
        ),
      ),
    );

    const response = await registry.searchAll(
      caller([Permission.PROJECTS]),
      ctx,
      'c1',
      'Site',
      { perRegister: 10, total: 3 },
    );

    expect(response.results).toHaveLength(3);
    expect(response.truncated).toBe(true);
  });
});

describe('rankResults', () => {
  it('puts an exact code match in the first tier', () => {
    const ranked = rankResults(
      [
        result('project', 'PRJ-014', 'Tirupati Yard', 'name'),
        result('vendor', 'TIRU', 'Tirupati Traders', 'code'),
      ],
      'TIRU',
    );
    // Only the tier is asserted, never the order inside it. A test pinning intra-tier
    // order fails on unrelated changes and teaches the next person to loosen the wrong
    // assertion.
    expect(ranked[0].code).toBe('TIRU');
  });

  it('is case-insensitive about the exact match', () => {
    const ranked = rankResults(
      [
        result('project', 'PRJ-014', 'Tirupati Yard'),
        result('vendor', 'TIRU', 'Tirupati Traders'),
      ],
      'tiru',
    );
    expect(ranked[0].code).toBe('TIRU');
  });

  it('preserves source order within a tier', () => {
    const ranked = rankResults(
      [
        result('project', 'PRJ-1', 'A'),
        result('project', 'PRJ-2', 'B'),
        result('project', 'PRJ-3', 'C'),
      ],
      'nothing-matches-exactly',
    );
    expect(ranked.map((r) => r.code)).toEqual(['PRJ-1', 'PRJ-2', 'PRJ-3']);
  });
});
