import { SLOT_FINAL, SLOT_FIRST_APPROVER, SLOT_HR } from './approval-slots';
import type { ChainLevelInput } from './chains.service';

/**
 * The action types and default chain shapes this feature ships (Constitution
 * Principle III — these are configuration, not literals scattered through services).
 *
 * A chain's *shape* can be seeded because the client described it: Employer → HR →
 * Director (Note 2). Its *staffing* mostly cannot — see `seedDefaultsForCompany`.
 */

/** The key attendance exceptions enter their chain under (spec FR-012). */
export const ACTION_ATTENDANCE_EXCEPTION = 'attendance_exception';

/**
 * Where historical, pre-chain resolutions are parked by the T027 backfill.
 *
 * A separate action type on a permanently **inactive** chain: inactive so it accepts
 * no new items and is invisible to the FR-021b guard, but present so a backfilled
 * instance has a real chain to point at and old work renders through the same path as
 * new work rather than needing a second code path in the interface forever.
 */
export const ACTION_ATTENDANCE_EXCEPTION_LEGACY = 'attendance_exception_legacy';

/** The key a payroll run enters its chain under (spec FR-013, FR-015). */
export const ACTION_PAYROLL_RUN = 'payroll_run';

/**
 * The action types FR-018 names besides payroll, declared here rather than in the modules
 * that will own them.
 *
 * None of these has a module behind it yet: payment release belongs to the payments work
 * and the three letter kinds to feature 017. They are declared now because the *gate* is
 * this feature's job and 017 must consume it rather than build its own (T050) — and a
 * constant a consuming feature imports is what makes "must consume" checkable instead of
 * merely requested.
 */
export const ACTION_PAYMENT_RELEASE = 'payment_release';
/**
 * Work order, LOI and purchase order kept as three action types rather than one
 * "money-committing letter".
 *
 * FR-018a's unit of configuration is the action type, so collapsing them would mean a
 * company that wants purchase orders gated but not LOIs cannot say so. Three rows in a
 * settings screen is the cost; the alternative costs a schema change.
 */
export const ACTION_LETTER_WORK_ORDER = 'letter_work_order';
export const ACTION_LETTER_LOI = 'letter_loi';
export const ACTION_LETTER_PURCHASE_ORDER = 'letter_purchase_order';
/** Full and final settlement on exit, including any waived recoveries (FR-018.4). */
export const ACTION_FINAL_SETTLEMENT = 'final_settlement';

/**
 * Employer → HR → Director, the shape Note 2 describes.
 *
 * Labels are set explicitly rather than left to the slot-key fallback because these
 * are the words the client used, and "Site / Employer" reads better on a queue row
 * than "First approver".
 */
export const DEFAULT_ATTENDANCE_EXCEPTION_LEVELS: ChainLevelInput[] = [
  { position: 1, slotKey: SLOT_FIRST_APPROVER, label: 'Site / Employer' },
  { position: 2, slotKey: SLOT_HR, label: 'HR' },
  {
    position: 3,
    slotKey: SLOT_FINAL,
    label: 'Director',
    isFinalAuthority: true,
  },
];

/**
 * Site Incharge → HR Office → Director, the shape Note 7 describes for payroll.
 *
 * The same three slots as the attendance chain, deliberately: the client's
 * "Employer → HR → Director" (Note 2) and "Site Incharge < HR Office < Director"
 * (Note 7) describe one three-tier shape at different levels of the organisation, not
 * two mechanisms (spec Assumptions). Reusing the slots means a company staffs its
 * approvers once and both chains follow.
 *
 * The labels differ because the words the client used differ, and a payroll approver
 * should see "Site Incharge" rather than the attendance queue's "Site / Employer".
 */
export const DEFAULT_PAYROLL_RUN_LEVELS: ChainLevelInput[] = [
  { position: 1, slotKey: SLOT_FIRST_APPROVER, label: 'Site Incharge' },
  { position: 2, slotKey: SLOT_HR, label: 'HR Office' },
  {
    position: 3,
    slotKey: SLOT_FINAL,
    label: 'Director',
    isFinalAuthority: true,
  },
];

/**
 * The default shape for the action types FR-018 names but no module has built yet.
 *
 * One level: the director. The client described these as "the director's final word", not
 * as chains — payment release and letter issue already sit at the end of whatever process
 * produced them. A longer chain can be defined per company through the settings endpoints;
 * this is the shape a company gets on day one, and it is the shape that makes FR-018 true
 * with the fewest people in the way.
 */
export const DEFAULT_DIRECTOR_FINAL_LEVELS: ChainLevelInput[] = [
  {
    position: 1,
    slotKey: SLOT_FINAL,
    label: 'Director',
    isFinalAuthority: true,
  },
];

/**
 * The action types seeded with the director-only chain above.
 *
 * `payroll_run` is absent deliberately: it has its own three-level chain (Note 7), and
 * seeding order matters less than saying why — a one-level payroll chain would drop the
 * Site Incharge and HR levels the client asked for.
 */
export const DIRECTOR_FINAL_SEEDED_ACTIONS: string[] = [
  ACTION_PAYMENT_RELEASE,
  ACTION_LETTER_WORK_ORDER,
  ACTION_LETTER_LOI,
  ACTION_LETTER_PURCHASE_ORDER,
  ACTION_FINAL_SETTLEMENT,
];
