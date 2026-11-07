import { AccessLevel, Permission } from '@prisma/client';

import { CLIENT_ROLES, rolesToRemove } from './client-roles';

/** The client's roles sheet, as the setup script writes it (2026-11-07). */
describe('CLIENT_ROLES', () => {
  const byName = new Map(CLIENT_ROLES.map((role) => [role.name, role]));
  const grant = (role: string, permission: Permission) =>
    byName.get(role)?.grants.find(([p]) => p === permission)?.[1];

  it('defines the seven roles on the sheet, once each', () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        'Billing Engineer',
        'Cashier',
        'HR Manager',
        'Operations Manager',
        'Plant and Machinery Incharge',
        'Purchase Manager',
        'Site Supervisor',
      ].sort(),
    );
    expect(byName.size).toBe(CLIENT_ROLES.length);
  });

  it('lets every role but the Site Supervisor work in both companies', () => {
    expect(
      CLIENT_ROLES.filter((role) => !role.allCompanies).map((r) => r.name),
    ).toEqual(['Site Supervisor']);
  });

  it('never hands out Super Admin, export or delete', () => {
    const handedOut = CLIENT_ROLES.flatMap((role) =>
      role.grants.map(([p]) => p),
    );
    for (const permission of [
      Permission.CROSS_COMPANY_ACCESS,
      Permission.DATA_EXPORT,
      Permission.DATA_DELETE,
    ]) {
      expect(handedOut).not.toContain(permission);
    }
  });

  it('splits labour: the supervisor marks attendance, the Operations Manager runs the rest', () => {
    expect(
      grant('Site Supervisor', Permission.LABOUR_ATTENDANCE),
    ).toBeDefined();
    expect(
      grant('Site Supervisor', Permission.DAILY_WORKER_REGISTRY),
    ).toBeUndefined();
    expect(
      grant('Operations Manager', Permission.DAILY_WORKER_REGISTRY),
    ).toBeDefined();
  });

  it('keeps a View tick to read only', () => {
    expect(grant('Operations Manager', Permission.MAINTENANCE)).toEqual([
      AccessLevel.read,
    ]);
    expect(grant('Billing Engineer', Permission.ASSETS)).toEqual([
      AccessLevel.read,
    ]);
  });

  it('lets the Purchase Manager edit Inventory, which opens every store to site entry', () => {
    expect(grant('Purchase Manager', Permission.INVENTORY)).toContain(
      AccessLevel.write,
    );
    expect(
      grant('Purchase Manager', Permission.INVENTORY_SITE_ENTRY),
    ).toBeDefined();
  });

  it('gives every role My Workspace', () => {
    for (const role of CLIENT_ROLES) {
      expect(grant(role.name, Permission.MY_WORKSPACE)).toBeDefined();
    }
  });
});

describe('rolesToRemove', () => {
  const role = (
    name: string,
    extra: Partial<{ isProtected: boolean; isDefault: boolean }> = {},
  ) => ({
    id: name,
    name,
    isProtected: false,
    isDefault: false,
    ...extra,
  });

  it('removes the roles that are not on the sheet', () => {
    const removed = rolesToRemove([
      role('Super Admin', { isProtected: true }),
      role('General User', { isDefault: true }),
      role('Operations Manager'),
      role('Inventory — Edit'),
      role('Site Admin'),
      role('HO User'),
      role('Labour Supervisor'),
      role('Download / Export'),
    ]);
    expect(removed.map((r) => r.name)).toEqual([
      'Site Admin',
      'HO User',
      'Labour Supervisor',
      'Download / Export',
    ]);
  });
});
