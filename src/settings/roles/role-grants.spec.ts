import { AccessLevel, Permission } from '@prisma/client';

import { RolesService } from './roles.service';

/**
 * How a role request becomes grant rows (019 T041, T042, T043).
 *
 * The private helper is reached through the service's own create path with a recording
 * Prisma double, because what matters is the rows that reach the database — a test against a
 * cast-away private method would pass while the caller wrote something else.
 */
describe('RolesService — grant rows', () => {
  const capture = () => {
    const created: Record<string, unknown>[] = [];
    const prisma = {
      role: {
        findUnique: async () => null,
        create: async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return { id: 'r-1', ...args.data };
        },
      },
    };
    const service = new RolesService(
      prisma as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
    );
    return { service, created };
  };

  const caller = { id: 'u-1', companyId: 'co-1' } as never;

  const rowsOf = (data: Record<string, unknown>) =>
    (
      data.rolePermissions as {
        create: { permission: Permission; level: AccessLevel }[];
      }
    ).create;

  it('gives read AND write when no levels are named', async () => {
    // What holding a permission has always meant, and what the Phase 1 backfill gave every
    // existing role. An administrator who names no levels gets today's behaviour, so no
    // existing caller of this endpoint changes meaning.
    const { service, created } = capture();
    await service.create(
      caller,
      { name: 'Site Clerk', permissions: [Permission.LOGBOOK] } as never,
      '127.0.0.1',
    );
    expect(rowsOf(created[0])).toEqual(
      expect.arrayContaining([
        { permission: Permission.LOGBOOK, level: AccessLevel.read },
        { permission: Permission.LOGBOOK, level: AccessLevel.write },
      ]),
    );
    expect(rowsOf(created[0])).toHaveLength(2);
  });

  it('honours an explicit read-only grant', async () => {
    const { service, created } = capture();
    await service.create(
      caller,
      {
        name: 'Site Operator',
        permissions: [Permission.MACHINERY],
        grants: [{ permission: Permission.MACHINERY, level: AccessLevel.read }],
      } as never,
      '127.0.0.1',
    );
    expect(rowsOf(created[0])).toEqual([
      { permission: Permission.MACHINERY, level: AccessLevel.read },
    ]);
  });

  it('refuses write without read, with 422 WRITE_WITHOUT_READ', async () => {
    // The spec left this open as an edge case. A role that may change records it cannot see
    // can neither find what to change nor see what it changed, and definition time is the
    // cheap place to say so.
    const { service } = capture();
    await expect(
      service.create(
        caller,
        {
          name: 'Broken',
          permissions: [Permission.MACHINERY],
          grants: [
            { permission: Permission.MACHINERY, level: AccessLevel.write },
          ],
        } as never,
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({
      response: { code: 'WRITE_WITHOUT_READ' },
    });
  });

  it('refuses a level for an area not listed in permissions', async () => {
    // `permissions` stays the set of areas the role touches, so every
    // `permissions.includes(...)` in the codebase keeps working. The two must not disagree.
    const { service } = capture();
    await expect(
      service.create(
        caller,
        {
          name: 'Mismatched',
          permissions: [Permission.LOGBOOK],
          grants: [{ permission: Permission.FUEL, level: AccessLevel.read }],
        } as never,
        '127.0.0.1',
      ),
    ).rejects.toMatchObject({
      response: { code: 'GRANT_AREA_NOT_LISTED' },
    });
  });

  it('keeps the default for an area the grants say nothing about', async () => {
    // The absence of a level is not a decision to remove one.
    const { service, created } = capture();
    await service.create(
      caller,
      {
        name: 'Mixed',
        permissions: [Permission.MACHINERY, Permission.LOGBOOK],
        grants: [{ permission: Permission.MACHINERY, level: AccessLevel.read }],
      } as never,
      '127.0.0.1',
    );
    const rows = rowsOf(created[0]);
    expect(rows).toEqual(
      expect.arrayContaining([
        { permission: Permission.MACHINERY, level: AccessLevel.read },
        { permission: Permission.LOGBOOK, level: AccessLevel.read },
        { permission: Permission.LOGBOOK, level: AccessLevel.write },
      ]),
    );
    expect(
      rows.filter(
        (r) =>
          r.permission === Permission.MACHINERY &&
          r.level === AccessLevel.write,
      ),
    ).toHaveLength(0);
  });

  it('writes the array and the rows in one statement', async () => {
    // `Role.permissions` is on its way out but is still what the rest of the codebase reads.
    // A role whose array and rows disagreed would grant one thing to the guard and another to
    // every service-level check, so the two must never be written apart.
    const { service, created } = capture();
    await service.create(
      caller,
      { name: 'Together', permissions: [Permission.LOGBOOK] } as never,
      '127.0.0.1',
    );
    expect(created[0].permissions).toEqual([Permission.LOGBOOK]);
    expect(created[0].rolePermissions).toBeDefined();
  });
});
