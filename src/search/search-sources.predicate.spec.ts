import { Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { RlsContext } from '../common/prisma/rls-context';
import {
  EmployeeSearchSource,
  fullName,
} from '../hr/employees/employee-search.source';
import { EquipmentSearchSource } from '../plant/equipment/equipment-search.source';
import { VendorSearchSource } from '../partners/vendors/vendor-search.source';
import {
  ProjectSearchSource,
  matchedOn,
} from '../projects/portfolio/project-search.source';
import { SearchSourcesRegistry } from './search-sources.registry';

/**
 * What each register actually asks the database, and how a result is shaped (021 T013,
 * T019).
 *
 * The queries are captured rather than executed: this repository has no `jest.mock`
 * anywhere, so the Prisma handle is a hand-built recorder whose `$transaction` runs the
 * callback against a fake transaction client. That keeps the assertion on the predicate —
 * prefix on code, substring on name — which is the part a refactor would silently change.
 */

interface Captured {
  where: Record<string, unknown>;
  take: number;
}

function recorder(delegate: string, rows: unknown[]) {
  const captured: Captured[] = [];
  const tx = {
    $executeRaw: async () => 0,
    [delegate]: {
      findMany: async (args: Captured) => {
        captured.push(args);
        return rows;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  return { prisma, captured };
}

const registry = () => new SearchSourcesRegistry();
const ctx: RlsContext = { isSuperAdmin: false, companyId: 'c1' };

describe('matchedOn', () => {
  it('reports a code match when the code starts with the term', () => {
    expect(matchedOn('PRJ-014', 'PRJ-01')).toBe('code');
  });

  it('reports a name match otherwise', () => {
    expect(matchedOn('PRJ-014', 'Tirupati')).toBe('name');
  });

  it('is case-insensitive and tolerates a padded term', () => {
    expect(matchedOn('PRJ-014', '  prj-0 ')).toBe('code');
  });

  it('calls a row matching both a code match, the stronger signal', () => {
    expect(matchedOn('TIRU', 'TIRU')).toBe('code');
  });
});

describe('ProjectSearchSource', () => {
  it('matches code by prefix and name by substring', async () => {
    const { prisma, captured } = recorder('project', []);
    const source = new ProjectSearchSource(prisma, registry());

    await source.search(ctx, 'c1', 'Tirupati', 7);

    const where = captured[0].where as {
      companyId: string;
      OR: Record<string, Record<string, string>>[];
    };
    // Company first: every predicate below runs inside one company's rows, which is what
    // makes an unindexed substring match tolerable.
    expect(where.companyId).toBe('c1');
    expect(where.OR[0].code.startsWith).toBe('Tirupati');
    expect(where.OR[1].name.contains).toBe('Tirupati');
    expect(captured[0].take).toBe(7);
  });

  it('declares the projects permission, not a settings one', () => {
    expect(
      new ProjectSearchSource(recorder('project', []).prisma, registry())
        .permission,
    ).toBe(Permission.PROJECTS);
  });

  it('shapes a result as a summary and an href, never a domain object', async () => {
    const { prisma } = recorder('project', [
      {
        id: 'p1',
        code: 'PRJ-014',
        name: 'Parth Tirupati Phase II',
        status: 'active',
      },
    ]);
    const [row] = await new ProjectSearchSource(prisma, registry()).search(
      ctx,
      'c1',
      'Tirupati',
      10,
    );

    expect(row).toEqual({
      register: 'project',
      id: 'p1',
      code: 'PRJ-014',
      label: 'Parth Tirupati Phase II',
      sublabel: 'active',
      matchedOn: 'name',
      href: '/projects/p1',
    });
  });
});

describe('VendorSearchSource', () => {
  it('offers no sublabel rather than an invented one', async () => {
    // `Vendor` carries no status. A sublabel that says nothing is worse than none, because
    // the reader spends attention on it.
    const { prisma } = recorder('vendor', [
      { id: 'v1', code: 'TIRU', name: 'Tirupati Traders' },
    ]);
    const [row] = await new VendorSearchSource(prisma, registry()).search(
      ctx,
      'c1',
      'TIRU',
      10,
    );
    expect(row.sublabel).toBeNull();
    expect(row.matchedOn).toBe('code');
  });
});

describe('EquipmentSearchSource', () => {
  it('requires MACHINERY, so logbook-only access is not a way into the register', () => {
    // A site operator holding LOGBOOK and FUEL has deliberately not been given the
    // machinery register (feature 019's whole premise). Search must not be the back door.
    const source = new EquipmentSearchSource(
      recorder('equipment', []).prisma,
      registry(),
    );
    expect(source.permission).toBe(Permission.MACHINERY);
    expect(source.permission).not.toBe(Permission.LOGBOOK);
    expect(source.permission).not.toBe(Permission.FUEL);
  });
});

describe('EmployeeSearchSource', () => {
  it('matches firstName and lastName independently, never concatenated', async () => {
    // A concatenated predicate is NULL in Postgres when either part is null, so the row
    // does not rank badly — it disappears. Somebody searching a surname needs those rows.
    const { prisma, captured } = recorder('employee', []);
    await new EmployeeSearchSource(prisma, registry()).search(
      ctx,
      'c1',
      'Kumar',
      10,
    );

    const or = (
      captured[0].where as { OR: Record<string, Record<string, string>>[] }
    ).OR;
    expect(or).toHaveLength(3);
    expect(or[0].employeeCode.startsWith).toBe('Kumar');
    expect(or[1].firstName.contains).toBe('Kumar');
    expect(or[2].lastName.contains).toBe('Kumar');
  });

  it('finds an employee who has only a last name', async () => {
    // The null-name case a concatenation would silently drop (T019).
    const { prisma } = recorder('employee', [
      {
        id: 'e1',
        employeeCode: 'EMP-9',
        firstName: null,
        lastName: 'Kumar',
        isActive: true,
      },
    ]);
    const [row] = await new EmployeeSearchSource(prisma, registry()).search(
      ctx,
      'c1',
      'Kumar',
      10,
    );
    expect(row.label).toBe('Kumar');
    expect(row.matchedOn).toBe('name');
  });

  it('says whether an exited employee is still active', async () => {
    const { prisma } = recorder('employee', [
      {
        id: 'e2',
        employeeCode: 'EMP-1',
        firstName: 'Ramesh',
        lastName: 'Kumar',
        isActive: false,
      },
    ]);
    const [row] = await new EmployeeSearchSource(prisma, registry()).search(
      ctx,
      'c1',
      'Ramesh',
      10,
    );
    // Findable, because you search for a record precisely when somebody has gone — but
    // the reader should not have to open it to learn that.
    expect(row.sublabel).toBe('Inactive');
  });
});

describe('fullName', () => {
  it('joins both parts', () => {
    expect(fullName('Ramesh', 'Kumar', 'EMP-1')).toBe('Ramesh Kumar');
  });

  it('falls back to the code rather than an empty label', () => {
    // A blank label looks like a rendering fault. The code is the one thing an employee
    // always has.
    expect(fullName(null, null, 'EMP-1')).toBe('EMP-1');
  });

  it('does not leave a stray space when one part is missing', () => {
    expect(fullName(null, 'Kumar', 'EMP-1')).toBe('Kumar');
    expect(fullName('Ramesh', null, 'EMP-1')).toBe('Ramesh');
  });
});
