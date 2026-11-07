import { AccessLevel, Permission } from '@prisma/client';

import { moduleRoles } from './module-roles';

/**
 * The client's roles, from `docs/Roles and Permissions.xlsx` (2026-11-07), and the rule for which
 * other roles go. `prisma/setup-client-roles.ts` writes them; this is the definition, kept here so
 * it is tested with the rest of the application.
 *
 * Read from the sheet column by column: "Allowed" and "Add & edit" give read and write, "View"
 * alone gives read. Two columns are not copied as they stand:
 * - **"Labour & attendance"** is split since 058 US4. The Site Supervisor gets the narrow
 *   `LABOUR_ATTENDANCE` (register labour, mark attendance); the Operations Manager gets
 *   `DAILY_WORKER_REGISTRY` (everything else in Labour).
 * - **"Download / export"** and **"Delete records"** control nothing (client, 2026-11-07): whoever
 *   can view a list may download it, and deleting a record is Super Admin only.
 *
 * "Company access": every role here works in both companies except the Site Supervisor. The sheet
 * left HR Manager blank; the client answered "both companies" on 2026-11-07.
 */
export interface ClientRole {
  name: string;
  allCompanies: boolean;
  grants: [Permission, AccessLevel[]][];
}

const both = [AccessLevel.read, AccessLevel.write];
const view = [AccessLevel.read];

export const CLIENT_ROLES: ClientRole[] = [
  {
    name: 'Operations Manager',
    allCompanies: true,
    grants: [
      [Permission.EMPLOYEES, both],
      [Permission.ATTENDANCE, both],
      [Permission.PAYROLL, both],
      [Permission.CHALLANS, both],
      [Permission.LOANS, both],
      [Permission.HR_LETTERS, both],
      [Permission.MACHINERY, both],
      [Permission.LOGBOOK, both],
      [Permission.FUEL, both],
      [Permission.MAINTENANCE, view],
      [Permission.MAINTENANCE_PAY, both],
      [Permission.HIRE_BILLS, both],
      [Permission.MACHINERY_DISPOSE, both],
      [Permission.INVENTORY, both],
      [Permission.DAILY_WORKER_REGISTRY, both],
      [Permission.LABOUR_APPROVE, both],
      [Permission.LABOUR_PUNCH_CORRECT, both],
      [Permission.ASSETS, both],
      [Permission.PARTNERS, view],
      [Permission.CASH_ENTRY, both],
      [Permission.MY_WORKSPACE, both],
    ],
  },
  {
    name: 'Billing Engineer',
    allCompanies: true,
    grants: [
      [Permission.PROJECTS, both],
      [Permission.PROJECT_FINANCIALS, both],
      [Permission.DWR, both],
      [Permission.HIRE_BILLS, both],
      [Permission.RECRUITMENT, both],
      [Permission.RECRUITMENT_APPROVE, both],
      [Permission.ASSETS, view],
      [Permission.PARTNERS, both],
      [Permission.MY_WORKSPACE, both],
    ],
  },
  {
    name: 'Plant and Machinery Incharge',
    allCompanies: true,
    grants: [
      [Permission.MACHINERY, both],
      [Permission.LOGBOOK, both],
      [Permission.FUEL, both],
      [Permission.MAINTENANCE, both],
      [Permission.MAINTENANCE_PAY, both],
      [Permission.HIRE_BILLS, both],
      [Permission.MACHINERY_DISPOSE, both],
      [Permission.INVENTORY, both],
      [Permission.INVENTORY_APPROVE, both],
      [Permission.ASSETS, both],
      [Permission.ASSETS_APPROVE, both],
      [Permission.PARTNERS, view],
      [Permission.CASH_ENTRY, both],
      [Permission.MY_WORKSPACE, both],
    ],
  },
  {
    name: 'Site Supervisor',
    allCompanies: false,
    grants: [
      [Permission.LABOUR_ATTENDANCE, both],
      [Permission.MY_WORKSPACE, both],
    ],
  },
  {
    name: 'HR Manager',
    allCompanies: true,
    grants: [
      [Permission.EMPLOYEES, both],
      [Permission.ATTENDANCE, both],
      [Permission.PAYROLL, both],
      [Permission.CHALLANS, both],
      [Permission.LOANS, view],
      [Permission.HR_LETTERS, both],
      [Permission.RECRUITMENT, both],
      [Permission.RECRUITMENT_APPROVE, both],
      [Permission.MY_WORKSPACE, both],
    ],
  },
  {
    name: 'Purchase Manager',
    allCompanies: true,
    grants: [
      [Permission.INVENTORY, both],
      [Permission.INVENTORY_APPROVE, both],
      [Permission.INVENTORY_SITE_ENTRY, both],
      [Permission.MY_WORKSPACE, both],
    ],
  },
  {
    name: 'Cashier',
    allCompanies: true,
    grants: [
      [Permission.CASH_ENTRY, both],
      [Permission.MY_WORKSPACE, both],
    ],
  },
];

export interface ExistingRole {
  id: string;
  name: string;
  isProtected: boolean;
  isDefault: boolean;
}

/**
 * The roles that go: everything but Super Admin (protected), the role every new account gets
 * (General User — every employee's own login), the client's roles above and the module roles.
 */
export function rolesToRemove<T extends ExistingRole>(roles: T[]): T[] {
  const kept = new Set([
    ...CLIENT_ROLES.map((role) => role.name),
    ...moduleRoles().map((role) => role.name),
  ]);
  return roles.filter(
    (role) => !role.isProtected && !role.isDefault && !kept.has(role.name),
  );
}
