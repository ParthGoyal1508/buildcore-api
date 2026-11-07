import { AccessLevel, Permission } from '@prisma/client';

import { labelOf, moduleRoles } from './module-roles';

/** 058 US5: the module roles the setup script creates. */
describe('moduleRoles (058)', () => {
  const roles = moduleRoles();
  const byName = new Map(roles.map((role) => [role.name, role]));

  it('never hands out cross-company access', () => {
    expect(
      roles.some((role) => role.permission === Permission.CROSS_COMPANY_ACCESS),
    ).toBe(false);
  });

  it('offers no export or delete role — neither controls anything (2026-11-07)', () => {
    const handedOut = new Set(roles.map((role) => role.permission));
    expect(handedOut.has(Permission.DATA_EXPORT)).toBe(false);
    expect(handedOut.has(Permission.DATA_DELETE)).toBe(false);
  });

  it('gives an area a View role (read) and an Edit role (read and write)', () => {
    expect(byName.get('Inventory — View')?.levels).toEqual([AccessLevel.read]);
    expect(byName.get('Inventory — Edit')?.levels).toEqual([
      AccessLevel.read,
      AccessLevel.write,
    ]);
  });

  it('gives a single ability one role', () => {
    expect(byName.has('Approve Indents')).toBe(true);
    expect(byName.has('Approve Indents — View')).toBe(false);
  });

  it('names each role once', () => {
    expect(byName.size).toBe(roles.length);
  });

  it('names the labour split the way the screens do', () => {
    expect(labelOf(Permission.DAILY_WORKER_REGISTRY)).toBe('Labour Management');
    expect(byName.has('Labour Registration & Attendance — Edit')).toBe(true);
  });
});
