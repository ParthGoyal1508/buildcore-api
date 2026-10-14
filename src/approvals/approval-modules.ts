import type { Prisma } from '@prisma/client';

import {
  ACTION_ATTENDANCE_CORRECTION,
  ACTION_ATTENDANCE_EXCEPTION,
  ACTION_ATTENDANCE_EXCEPTION_LEGACY,
  ACTION_CLIENT_BILL,
  ACTION_DIRECTOR_FINAL_SET_CHANGE,
  ACTION_DWR,
  ACTION_EXIT_CLEARANCE_WAIVER,
  ACTION_FINAL_SETTLEMENT,
  ACTION_OPERATOR_FUEL_RECOVERY,
  ACTION_PAYMENT_RELEASE,
  ACTION_PAYROLL_RUN,
  ACTION_PURCHASE_RATE_CHANGE,
  ACTION_RA_BILL,
  ACTION_WORK_ORDER_AWARD,
} from './default-chains';

/**
 * Which part of the product an approval belongs to, derived from its action type
 * (2026-10-15).
 *
 * ## Why this exists
 *
 * The client asked for the Approvals screen to be "grouped by module". The spine stores
 * no module — it stores an `actionType` on the chain and an opaque `(entityType,
 * entityId)` it never dereferences (research.md §1) — so the grouping has to be a
 * mapping from the one thing it does hold. Kept here, beside the action-type constants
 * it maps, so a new action type is classified in the same file it is declared in, and
 * so the web never keeps a second copy: every history row and queue row carries its
 * `module` and `moduleLabel` already resolved.
 *
 * ## Exact types first, then prefixes
 *
 * Letters register one action type per letter kind, and kinds are data (017 FR-011) —
 * `letter_work_order`, `letter_loi`, and whatever an administrator adds next. A prefix
 * is the only rule that classifies a kind nobody has created yet. Everything else is an
 * exact list, because a prefix like `attendance_` would happily claim an action type a
 * later feature meant for somewhere else.
 *
 * Anything unmatched is `other` — shown, under "Other", never dropped. A screen that
 * hid an approval because nobody had classified its type would be the worst failure
 * this file could have.
 */
export interface ApprovalModule {
  key: string;
  label: string;
  actionTypes: readonly string[];
  prefixes?: readonly string[];
}

/** In the order the Approvals screen lists its groups. */
export const APPROVAL_MODULES: readonly ApprovalModule[] = [
  {
    key: 'billing',
    label: 'Bills & work orders',
    actionTypes: [
      ACTION_RA_BILL,
      ACTION_CLIENT_BILL,
      ACTION_WORK_ORDER_AWARD,
      ACTION_PAYMENT_RELEASE,
    ],
  },
  {
    key: 'letters',
    label: 'Letters',
    actionTypes: [],
    prefixes: ['letter_'],
  },
  {
    key: 'dwr',
    label: 'Daily work reports',
    actionTypes: [ACTION_DWR],
  },
  {
    key: 'attendance',
    label: 'Attendance',
    actionTypes: [
      ACTION_ATTENDANCE_EXCEPTION,
      ACTION_ATTENDANCE_EXCEPTION_LEGACY,
      ACTION_ATTENDANCE_CORRECTION,
    ],
  },
  {
    key: 'payroll',
    label: 'Payroll & exits',
    actionTypes: [
      ACTION_PAYROLL_RUN,
      ACTION_FINAL_SETTLEMENT,
      ACTION_EXIT_CLEARANCE_WAIVER,
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory & purchasing',
    // `material_indent` is raised by inventory under a literal rather than a constant
    // in `default-chains.ts`; it is listed here by value for that reason.
    actionTypes: [ACTION_PURCHASE_RATE_CHANGE, 'material_indent'],
  },
  {
    key: 'plant',
    label: 'Plant & machinery',
    actionTypes: [ACTION_OPERATOR_FUEL_RECOVERY],
  },
  {
    key: 'settings',
    label: 'Settings',
    actionTypes: [ACTION_DIRECTOR_FINAL_SET_CHANGE],
  },
];

export const OTHER_MODULE = { key: 'other', label: 'Other' } as const;

/** Every module key a caller may filter by, `other` included. */
export const APPROVAL_MODULE_KEYS: readonly string[] = [
  ...APPROVAL_MODULES.map((m) => m.key),
  OTHER_MODULE.key,
];

/** The module an action type belongs to — `other` when nothing claims it. */
export function moduleOf(actionType: string): { key: string; label: string } {
  for (const m of APPROVAL_MODULES) {
    if (
      m.actionTypes.includes(actionType) ||
      m.prefixes?.some((p) => actionType.startsWith(p))
    ) {
      return { key: m.key, label: m.label };
    }
  }
  return OTHER_MODULE;
}

/** The `actionType` filter that selects one module's chains, for a Prisma `where`. */
function actionTypeMatch(m: ApprovalModule): Prisma.ApprovalChainWhereInput[] {
  return [
    ...(m.actionTypes.length
      ? [{ actionType: { in: [...m.actionTypes] } }]
      : []),
    ...(m.prefixes ?? []).map((p) => ({ actionType: { startsWith: p } })),
  ];
}

/**
 * The chain filter for one module key. `other` is everything no module claims, so it is
 * written as the negation of all of them — the same definition `moduleOf` applies row
 * by row, which is what keeps the filter and the grouping from disagreeing.
 */
export function chainWhereForModule(
  key: string,
): Prisma.ApprovalChainWhereInput {
  if (key === OTHER_MODULE.key) {
    return { NOT: { OR: APPROVAL_MODULES.flatMap(actionTypeMatch) } };
  }
  const m = APPROVAL_MODULES.find((x) => x.key === key);
  // Validated at the DTO; an unknown key reaching here matches nothing rather than
  // everything, which is the safe direction for a filter.
  if (!m) return { id: { in: [] } };
  return { OR: actionTypeMatch(m) };
}
