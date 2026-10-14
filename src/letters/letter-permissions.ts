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
  // Every letter to an employee is HR's, and HR's alone (2026-10-15). They were spread over
  // `EMPLOYEES` and `PAYROLL`, which site admins, project managers and accountants hold to do
  // their own work — and which therefore let them issue a termination or an increment letter.
  // The client's rule is that HR issues these; `HR_LETTERS` is that rule as a permission, held
  // by HO User and Super Admin and grantable to any other role in Settings → Roles.
  appointment: Permission.HR_LETTERS,
  confirmation: Permission.HR_LETTERS,
  relieving: Permission.HR_LETTERS,
  experience: Permission.HR_LETTERS,
  transfer: Permission.HR_LETTERS,
  suspension: Permission.HR_LETTERS,
  termination: Permission.HR_LETTERS,
  increment: Permission.HR_LETTERS,
  fnf_settlement: Permission.HR_LETTERS,
  // The payslip is produced by the payroll run, not composed by anyone, so it stays payroll's.
  salary_slip: Permission.PAYROLL,

  // The two that commit a project's money. `PROJECT_FINANCIALS` rather than `PROJECTS`:
  // issuing a work order is a spending decision, and 009 and 013 both established that
  // spending decisions are separable from the module's read permission.
  letter_work_order: Permission.PROJECT_FINANCIALS,
  letter_loi: Permission.PROJECT_FINANCIALS,
  // A purchase order is not a project's (2026-10-15): the client buys materials for the
  // company, against the item master, from Inventory → Purchase Orders — addressed to the
  // vendor, not to a site. So it sits with the people who buy, `INVENTORY`, as the indent
  // and service order do. It still commits money, and the spending decision is the
  // director-final approval chain every PO passes through before it can be issued — not
  // which module's read permission the person composing it holds.
  letter_purchase_order: Permission.INVENTORY,

  // A payment leaving the company against a vendor's bill (2026-10-11). Money, so it
  // sits with the three above rather than with procurement paperwork — a payment advice
  // tells a vendor the transfer has been made, and anyone who can issue one can assert
  // that it was.
  payment_advice: Permission.PROJECT_FINANCIALS,

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

/**
 * Everyone who may issue some kind of letter, plus administrators (2026-10-14).
 *
 * The kinds list and the signatories list are what the composer needs before it can issue
 * anything. Both were `SETTINGS`-only, so an HR user holding `EMPLOYEES` could compose a
 * relieving letter but not see which kinds exist or pick who signs it. Reading them is
 * granted to anyone who can issue at least one kind; changing them stays `SETTINGS`.
 */
export const LETTER_READ_PERMISSIONS: Permission[] = [
  ...new Set([
    LETTER_KIND_DEFAULT_PERMISSION,
    ...Object.values(LETTER_KIND_PERMISSIONS),
  ]),
];
