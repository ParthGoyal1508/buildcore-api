import { Permission, PrismaClient } from '@prisma/client';

/**
 * The nine default roles (002 FR-006).
 *
 * Six of them (Super Admin, Project Manager, Accountant, Site Engineer, Store
 * Keeper, Viewer) carry the permission sets documented verbatim in the PRD's Roles
 * table (ERP-Demo docs/settings.md). The remaining three (Site Admin, HO User, Site
 * User) are named by FR-006 and described in the master PRD but have no documented
 * permission list anywhere; theirs are derived from those descriptions and were
 * approved explicitly rather than assumed:
 *
 *   Site Admin — "full access within assigned company/site": everything except the
 *     three cross-company/destructive capabilities (CROSS_COMPANY_ACCESS,
 *     COMPANY_SETTINGS, DATA_DELETE).
 *   HO User    — "head-office staff; read/write most modules", plus USER_MANAGEMENT,
 *     which FR-014 requires for the user-administration endpoints.
 *   Site User  — "limited read + My Workspace".
 *
 * The PRD's Store Keeper row lists "Purchases, Issues, Transfers"; those are
 * Inventory sub-tabs, not members of the Permission enum, so they collapse to
 * INVENTORY.
 */
export const DEFAULT_ROLES: {
  name: string;
  isProtected: boolean;
  permissions: Permission[];
}[] = [
  {
    name: 'Super Admin',
    isProtected: true,
    permissions: Object.values(Permission),
  },
  {
    name: 'Site Admin',
    isProtected: false,
    permissions: Object.values(Permission).filter(
      (p) =>
        p !== Permission.CROSS_COMPANY_ACCESS &&
        p !== Permission.COMPANY_SETTINGS &&
        p !== Permission.DATA_DELETE,
    ),
  },
  {
    name: 'Project Manager',
    isProtected: false,
    permissions: [
      Permission.DASHBOARD,
      Permission.EMPLOYEES,
      Permission.ATTENDANCE,
      Permission.PROJECTS,
      Permission.DWR,
      Permission.MACHINERY,
      Permission.REPORTS,
    ],
  },
  {
    name: 'HO User',
    isProtected: false,
    permissions: [
      Permission.DASHBOARD,
      Permission.EMPLOYEES,
      Permission.ATTENDANCE,
      Permission.PROJECTS,
      Permission.DWR,
      Permission.PROJECT_FINANCIALS,
      Permission.MACHINERY,
      Permission.INVENTORY,
      Permission.PARTNERS,
      Permission.REPORTS,
      Permission.PAYROLL,
      Permission.CHALLANS,
      Permission.LOANS,
      Permission.DAILY_WORKER_REGISTRY,
      Permission.USER_MANAGEMENT,
      Permission.DATA_EXPORT,
    ],
  },
  {
    name: 'Accountant',
    isProtected: false,
    permissions: [
      Permission.DASHBOARD,
      Permission.PAYROLL,
      Permission.CHALLANS,
      Permission.LOANS,
      Permission.INVENTORY,
      Permission.REPORTS,
    ],
  },
  {
    name: 'Site Engineer',
    isProtected: false,
    permissions: [
      Permission.DASHBOARD,
      Permission.ATTENDANCE,
      Permission.DWR,
      Permission.MACHINERY,
      Permission.LOGBOOK,
      Permission.FUEL,
      Permission.INVENTORY,
    ],
  },
  {
    name: 'Store Keeper',
    isProtected: false,
    permissions: [Permission.DASHBOARD, Permission.INVENTORY],
  },
  {
    name: 'Site User',
    isProtected: false,
    permissions: [
      Permission.DASHBOARD,
      Permission.MY_WORKSPACE,
      Permission.ATTENDANCE,
    ],
  },
  {
    name: 'Viewer',
    isProtected: false,
    permissions: [Permission.DASHBOARD, Permission.REPORTS],
  },
];

/**
 * Idempotent — upserts by the role's unique name, so re-seeding refreshes the
 * default permission sets without orphaning the `UserRole` assignments that
 * reference these rows by id. Super Admin already exists (created by
 * 20260828170000_role_permission_model, which feature 001 needed before 002 was
 * built); upserting simply keeps its permission set current.
 */
export async function seedDefaultRoles(prisma: PrismaClient): Promise<void> {
  for (const role of DEFAULT_ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: { permissions: role.permissions, isProtected: role.isProtected },
      create: {
        name: role.name,
        permissions: role.permissions,
        isProtected: role.isProtected,
      },
    });
  }
}
