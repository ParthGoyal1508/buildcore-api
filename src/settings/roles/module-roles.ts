import { AccessLevel, Permission } from '@prisma/client';

/**
 * The module-specific roles (058 US5): for every module a "<Module> — View" role (read) and a
 * "<Module> — Edit" role (read and write), and for every single-ability permission one "<Ability>"
 * role. `prisma/seed-module-roles.ts` creates them; this is the list, kept here so it is tested with
 * the rest of the application.
 */
/**
 * Permissions that are one ability rather than an area with a view/edit split — the same set the
 * web treats as level-agnostic, plus delete, which the client's sheet lists as a single "Allowed".
 */
const SINGLE_ABILITY: ReadonlySet<Permission> = new Set([
  Permission.LABOUR_APPROVE,
  Permission.INVENTORY_APPROVE,
  Permission.RECRUITMENT_APPROVE,
  Permission.ASSETS_APPROVE,
  Permission.HR_LETTERS,
  Permission.LABOUR_PUNCH_CORRECT,
  Permission.MACHINERY_DISPOSE,
  Permission.PROJECT_LOCK,
  Permission.MAINTENANCE_PAY,
  Permission.INVENTORY_SITE_ENTRY,
  Permission.PAYMENTS,
]);

/**
 * Never handed out as a module role. Cross-company access is Super Admin. Export and delete control
 * nothing (client, 2026-11-07): whoever can view a list may download it, and deleting a record is
 * Super Admin only (`RecordDeleteInterceptor`).
 */
const NEVER: ReadonlySet<Permission> = new Set([
  Permission.CROSS_COMPANY_ACCESS,
  Permission.DATA_EXPORT,
  Permission.DATA_DELETE,
]);

/** The names the screens use, where the enum's own spelling would read badly. */
const LABELS: Partial<Record<Permission, string>> = {
  [Permission.DWR]: 'Daily Work Reports',
  [Permission.DAILY_WORKER_REGISTRY]: 'Labour Management',
  [Permission.LABOUR_ATTENDANCE]: 'Labour Registration & Attendance',
  [Permission.LABOUR_APPROVE]: 'Labour Approvals',
  [Permission.LABOUR_PUNCH_CORRECT]: 'Correct Labour Punch Time',
  [Permission.INVENTORY_APPROVE]: 'Approve Indents',
  [Permission.INVENTORY_SITE_ENTRY]: 'Inventory Site Delivery Entry',
  [Permission.RECRUITMENT_APPROVE]: 'Recruitment Approvals',
  [Permission.ASSETS_APPROVE]: 'Asset Approvals',
  [Permission.HR_LETTERS]: 'HR Letters',
  [Permission.MACHINERY_DISPOSE]: 'Scrap or Sell a Machine',
  [Permission.MAINTENANCE_PAY]: 'Pay Job Card Bills',
  [Permission.PROJECT_LOCK]: 'Lock or Unlock a Project',
  [Permission.PROJECT_FINANCIALS]: 'Project Billing & Finance',
  [Permission.CASH_ENTRY]: 'Cash Payments',
  [Permission.PAYMENTS]: 'Record Payments',
  [Permission.SETTINGS]: 'Masters & Setup',
  [Permission.USER_MANAGEMENT]: 'Users & Roles',
  [Permission.COMPANY_SETTINGS]: 'Company Setup',
  [Permission.DATA_EXPORT]: 'Download / Export',
  [Permission.DATA_DELETE]: 'Delete Records',
};

export function labelOf(permission: Permission): string {
  return (
    LABELS[permission] ??
    permission
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  );
}

export interface ModuleRole {
  name: string;
  permission: Permission;
  levels: AccessLevel[];
}

/** Every role this script would create, in a stable order. */
export function moduleRoles(): ModuleRole[] {
  return Object.values(Permission)
    .filter((permission) => !NEVER.has(permission))
    .flatMap((permission): ModuleRole[] => {
      const label = labelOf(permission);
      if (SINGLE_ABILITY.has(permission)) {
        return [
          {
            name: label,
            permission,
            levels: [AccessLevel.read, AccessLevel.write],
          },
        ];
      }
      return [
        { name: `${label} — View`, permission, levels: [AccessLevel.read] },
        {
          name: `${label} — Edit`,
          permission,
          levels: [AccessLevel.read, AccessLevel.write],
        },
      ];
    });
}
