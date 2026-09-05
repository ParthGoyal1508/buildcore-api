import { AuditEntityType } from '@prisma/client';

/** The PRD's Activity Log module filter buckets (data-model.md). */
export type ActivityModule =
  | 'hr'
  | 'settings'
  | 'payroll'
  | 'machinery'
  | 'projects'
  | 'inventory'
  | 'partners'
  | 'recruitment'
  | 'labour';

/**
 * Which `AuditEntityType` values roll up into each PRD module bucket (research.md §4,
 * data-model.md). `AuditEntityType` is per-entity; the Activity Log filter is
 * per-module — this is the static mapping between them, computed at query time rather
 * than stored on the row (research.md §4, alternatives). Login events and HR
 * entities both fall under "HR" per the PRD's own action list; the reminders engine's
 * one audited action and this feature's own export action fold in there too.
 *
 * Buckets whose modules exist but have produced no audited actions simply match zero
 * rows — selecting them returns an empty feed, not an error (spec Edge Cases).
 */
export const MODULE_ENTITY_TYPES: Record<ActivityModule, AuditEntityType[]> = {
  hr: [
    AuditEntityType.LOGIN_SUCCESS,
    AuditEntityType.LOGIN_FAILURE,
    AuditEntityType.ACCOUNT_LOCKED,
    AuditEntityType.LOGOUT,
    AuditEntityType.REFRESH_REUSE_DETECTED,
    AuditEntityType.ADMIN_PASSWORD_RESET,
    AuditEntityType.PUNCH,
    AuditEntityType.LEAVE_APPLICATION,
    AuditEntityType.FACE_ENROLMENT,
    AuditEntityType.RE_ENROLMENT_REQUEST,
    AuditEntityType.REIMBURSEMENT_CLAIM,
    AuditEntityType.EMPLOYEE,
    AuditEntityType.EMPLOYEE_DOCUMENT,
    AuditEntityType.EMPLOYEE_TRANSFER,
    AuditEntityType.ATTENDANCE,
    AuditEntityType.HOLIDAY,
    AuditEntityType.EXIT_RECORD,
    AuditEntityType.REMINDER,
    AuditEntityType.REPORT_EXPORT,
  ],
  settings: [
    AuditEntityType.COMPANY,
    AuditEntityType.ROLE,
    AuditEntityType.DEPARTMENT,
    AuditEntityType.DESIGNATION,
    AuditEntityType.DOCUMENT_TYPE,
    AuditEntityType.SHIFT,
    AuditEntityType.USER_ACCOUNT,
  ],
  payroll: [
    AuditEntityType.PAYROLL_RUN,
    AuditEntityType.LOAN,
    AuditEntityType.TAX_DECLARATION,
    AuditEntityType.SALARY_ADVANCE,
  ],
  machinery: [
    AuditEntityType.EQUIPMENT,
    AuditEntityType.EQUIPMENT_DOCUMENT,
    AuditEntityType.LOGBOOK_ENTRY,
    AuditEntityType.FUEL_ENTRY,
    AuditEntityType.SERVICE_SCHEDULE,
    AuditEntityType.MAINTENANCE_JOB,
    AuditEntityType.HIRE_BILL,
    AuditEntityType.EQUIPMENT_CATEGORY,
    AuditEntityType.EQUIPMENT_DOC_TYPE,
    AuditEntityType.HIRE_RATE,
    AuditEntityType.SPARE_PART,
    AuditEntityType.SPARE_PART_MOVEMENT,
    AuditEntityType.SERVICE_BILL,
  ],
  projects: [
    AuditEntityType.PROJECT,
    AuditEntityType.CLIENT,
    AuditEntityType.SITE,
    AuditEntityType.BOQ_GROUP,
    AuditEntityType.BOQ_ITEM,
    AuditEntityType.DWR,
    AuditEntityType.REVENUE,
    AuditEntityType.RA_BILL,
    AuditEntityType.WORK_ORDER,
    AuditEntityType.PROJECT_BUDGET,
    AuditEntityType.PROJECT_DOCUMENT,
  ],
  inventory: [
    AuditEntityType.ITEM_CATEGORY,
    AuditEntityType.ITEM,
    AuditEntityType.PURCHASE,
    AuditEntityType.GOODS_RECEIPT_NOTE,
    AuditEntityType.ISSUE,
    AuditEntityType.STOCK_TRANSFER,
    AuditEntityType.PAYMENT,
    AuditEntityType.MATERIAL_INDENT,
  ],
  partners: [
    AuditEntityType.VENDOR,
    AuditEntityType.VENDOR_CATEGORY,
    AuditEntityType.CONTRACTOR_PROFILE,
    AuditEntityType.CONTRACTOR_DOCUMENT,
    AuditEntityType.MONTHLY_COMPLIANCE,
    AuditEntityType.BOCW_PAYMENT,
  ],
  recruitment: [
    AuditEntityType.REQUISITION,
    AuditEntityType.CANDIDATE,
    AuditEntityType.INTERVIEW,
    AuditEntityType.OFFER,
    AuditEntityType.ONBOARDING_ITEM,
    AuditEntityType.LETTER,
    AuditEntityType.RESIGNATION,
  ],
  labour: [
    AuditEntityType.SKILL_CATEGORY,
    AuditEntityType.WAGE_RATE,
    AuditEntityType.LABOUR_WORKER,
    AuditEntityType.LABOUR_GANG,
    AuditEntityType.MUSTER_ROLL,
    AuditEntityType.LABOUR_PAYMENT_SHEET,
    AuditEntityType.LABOUR_ADVANCE,
  ],
};

/** Reverse lookup: the module bucket one entity type belongs to. */
const ENTITY_TYPE_TO_MODULE = new Map<AuditEntityType, ActivityModule>(
  (
    Object.entries(MODULE_ENTITY_TYPES) as [ActivityModule, AuditEntityType[]][]
  ).flatMap(([module, types]) =>
    types.map((t): [AuditEntityType, ActivityModule] => [t, module]),
  ),
);

/** The entity types a module filter selects, or `null` for an unknown module. */
export function entityTypesForModule(
  module: string | undefined,
): AuditEntityType[] | null {
  if (!module) return null;
  return MODULE_ENTITY_TYPES[module as ActivityModule] ?? [];
}

/** The module bucket an entity type belongs to. */
export function moduleForEntityType(
  type: AuditEntityType,
): ActivityModule | 'other' {
  return ENTITY_TYPE_TO_MODULE.get(type) ?? 'other';
}
