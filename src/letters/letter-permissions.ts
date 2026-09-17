import { Permission } from '@prisma/client';

/**
 * Which permission each letter kind requires (017 contract Part 2, "per kind").
 *
 * **There is no single `LETTERS` permission**, for the same reason 016 has no
 * `APPROVALS` permission: a work order and a relieving letter are not the same
 * authority. Somebody who may issue an experience certificate has no business
 * committing the company to a purchase order, and one permission covering both would
 * make that indistinguishable.
 *
 * Configuration rather than literals in the service (Principle III), following
 * `src/approvals/default-chains.ts`.
 */
export const LETTER_KIND_PERMISSIONS: Record<string, Permission> = {
  // HR and recruitment letters — the five migrated from the old enum, plus the two
  // employment-lifecycle additions.
  offer: Permission.RECRUITMENT,
  appointment: Permission.RECRUITMENT,
  confirmation: Permission.EMPLOYEES,
  relieving: Permission.EMPLOYEES,
  experience: Permission.EMPLOYEES,
  transfer: Permission.EMPLOYEES,
  suspension: Permission.EMPLOYEES,
  salary_slip: Permission.PAYROLL,

  // The three that commit money. `PROJECT_FINANCIALS` rather than `PROJECTS`: issuing a
  // work order is a spending decision, and 009 and 013 both established that spending
  // decisions are separable from the module's read permission.
  letter_work_order: Permission.PROJECT_FINANCIALS,
  letter_loi: Permission.PROJECT_FINANCIALS,
  letter_purchase_order: Permission.PROJECT_FINANCIALS,

  // Procurement paperwork.
  indent: Permission.INVENTORY,
  service_order: Permission.INVENTORY,
  service_bill: Permission.INVENTORY,
  maintenance_bill: Permission.MACHINERY,
};

/**
 * What a kind with no entry requires.
 *
 * FR-011 lets an administrator define a kind this file has never heard of, so there
 * must be an answer for one. `SETTINGS` — the permission of the person who defined it —
 * is the **closed** answer: the new kind is issuable by administrators until somebody
 * decides who else may issue it. The open answer, letting any authenticated caller
 * issue an unmapped kind, would turn FR-011 into a way to route around every permission
 * in this map.
 */
export const LETTER_KIND_DEFAULT_PERMISSION: Permission = Permission.SETTINGS;

export function permissionForKind(key: string): Permission {
  return LETTER_KIND_PERMISSIONS[key] ?? LETTER_KIND_DEFAULT_PERMISSION;
}
