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
  | 'labour'
  | 'assets';

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
    // Feature 016's approval decisions and refused attempts.
    //
    // Folded in here for the same reason REMINDER and REPORT_EXPORT are: the approval
    // spine is cross-module by design, and the audit row records the decision rather
    // than the module the decided item belongs to, so there is nothing to bucket it by.
    // `hr` is also where it genuinely belongs today — attendance exceptions are the
    // first and only module on the chain (spec FR-012).
    //
    // Worth revisiting once payroll and inventory migrate: the row's `changes` JSON
    // does carry the item's `entityType`, so a future Activity Log could bucket on that
    // instead of on the audit type. Doing it now would mean a new module filter option
    // appearing in the interface, which is outside this feature's Phase 1.
    AuditEntityType.APPROVAL_DECISION,
    AuditEntityType.APPROVAL_REFUSED,
  ],
  settings: [
    AuditEntityType.COMPANY,
    AuditEntityType.ROLE,
    AuditEntityType.DEPARTMENT,
    AuditEntityType.DESIGNATION,
    AuditEntityType.DOCUMENT_TYPE,
    AuditEntityType.SHIFT,
    AuditEntityType.USER_ACCOUNT,
    // Who is allowed to approve what is a settings change, and reads as one in the feed
    // — unlike the decisions above, which are operational.
    AuditEntityType.APPROVAL_CHAIN_CONFIG,
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
  // Project Assets (012). Its own bucket rather than folded into `inventory`: the
  // two registers answer to different people, which is the same reason 012 refused
  // to reuse the `INVENTORY` permission. The three masters sit here with the
  // operational types because 012 is what creates and audits them, even though the
  // tables are `settings`-schema — the same call the `AuditEntityType` enum makes.
  assets: [
    AuditEntityType.ASSET,
    AuditEntityType.ASSET_ALLOCATION,
    AuditEntityType.ASSET_TRANSFER,
    AuditEntityType.ASSET_REQUEST,
    AuditEntityType.ASSET_INSPECTION,
    AuditEntityType.ASSET_REPAIR,
    AuditEntityType.ASSET_CATEGORY,
    AuditEntityType.ASSET_DOC_TYPE,
    AuditEntityType.CONDITION_GRADE,
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
