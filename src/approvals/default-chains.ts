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

/**
 * The key a **manual attendance correction** enters its chain under (016 FR-012, T072).
 *
 * ## A deliberate deviation from T072, recorded rather than done quietly
 *
 * T072 said to reuse `ACTION_ATTENDANCE_EXCEPTION` rather than introduce a key, to avoid
 * migrating live instances and slot mappings. That reasoning is sound for *renaming* a
 * type and does not apply to *adding* one — `seedDefaultsForCompany` is idempotent per
 * chain, existing instances keep their type, and the new chain is additive rows.
 *
 * Reusing the key would have been actively wrong. `attendance-exceptions.service.ts`
 * already handles `approval.completed` for `ACTION_ATTENDANCE_EXCEPTION` and treats
 * `entityId` as a **punch id**; a correction's `entityId` is a
 * `PendingAttendanceCorrection` id. Both handlers filter on `entityType` alone, so each
 * would receive the other's completions and silently no-op — relying on a `where` clause
 * matching nothing is not isolation, and the day somebody loosens one of those clauses the
 * two features corrupt each other's rows.
 *
 * Same three-level shape as the exception chain, so a company staffs its approvers once.
 */
export const ACTION_ATTENDANCE_CORRECTION = 'attendance_correction';

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
/**
 * Changing which action types the Director must approve (016 FR-018b).
 *
 * Itself director-final, seeded that way by migration and **never offered as configurable**.
 * If the gate on removing gates could be removed, that is the first thing anybody bypassing
 * the chain would remove.
 */
export const ACTION_DIRECTOR_FINAL_SET_CHANGE = 'director_final_set_change';

/** Full and final settlement on exit, including any waived recoveries (FR-018.4). */
export const ACTION_FINAL_SETTLEMENT = 'final_settlement';

/**
 * Recovering lost fuel from an operator's salary (020 FR-006).
 *
 * **Not in `DIRECTOR_FINAL_SEEDED_ACTIONS`, and that is the confirmed set rather than an omission.**
 * The client confirmed on 2026-10-02 that the four director-final actions are payment release,
 * payroll run, money-committing letters and final settlement. A fuel recovery is none of them, so it
 * takes the same Employer → HR → Director shape as an attendance correction — which still ends at the
 * Director, but as the last level of a three-level chain rather than as a one-level gate.
 *
 * Declared here with every other action type rather than inside `plant`, so the module raising it
 * imports the key rather than inventing one. That is what makes FR-006's "no path to a payroll line
 * except through an approved item" checkable: there is exactly one key, and one handler watching it.
 */
export const ACTION_OPERATOR_FUEL_RECOVERY = 'operator_fuel_recovery';

/**
 * Waiving an outstanding obligation on an exit clearance (021 FR-016).
 *
 * **The client's answer was "HR, with a Director countersign"**, which is one approval level and not
 * a chain: HR proposes by submitting, and the Director is the only approver. That is the same shape
 * the director-final actions take, so it is seeded the same way — but it is a *countersignature on
 * an HR act*, not a fifth entry in the four actions the client named as needing the Director's final
 * word. See `DIRECTOR_FINAL_SEEDED_ACTIONS` below, where the two senses are separated.
 *
 * Registered beside `ACTION_FINAL_SETTLEMENT`, the action it unblocks. A waiver that had its own
 * approval path would be a second way to authorise the same money, which is exactly what 016's
 * FR-022 forbids each module from inventing.
 */
export const ACTION_EXIT_CLEARANCE_WAIVER = 'exit_clearance_waiver';

/**
 * Certifying a subcontractor's RA bill (018 FR-009, Phase 4).
 *
 * **Deliberately not added to `DIRECTOR_FINAL_SEEDED_ACTIONS` below**, even though its default chain
 * is one Director level. That list carries a policy claim — the actions the client confirmed require
 * the Director's final word — and an RA bill is not on it. The one-level default here is the minimum
 * gate that makes FR-009 mean something, not an assertion about who the client wants signing.
 *
 * A longer chain is a settings change, per company, through the existing endpoints. What is *not*
 * configurable, and is the whole of FR-009, is that editing a certified bill's quantities sends it
 * round again.
 */
export const ACTION_RA_BILL = 'ra_bill';

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
 * **Two senses of "director-final" meet in this list, and keeping them apart matters.** The first
 * six are the actions the client named as requiring the Director's final word — a policy answer,
 * confirmed on 2026-10-02, and the reason `ACTION_OPERATOR_FUEL_RECOVERY` is deliberately *not*
 * here. The last is an action whose default chain happens to be one Director level because that is
 * what a countersignature is; adding it does not widen the confirmed policy set.
 *
 * `payroll_run` is absent deliberately: it has its own three-level chain (Note 7), and
 * seeding order matters less than saying why — a one-level payroll chain would drop the
 * Site Incharge and HR levels the client asked for.
 */
export const DIRECTOR_FINAL_SEEDED_ACTIONS: string[] = [
  ACTION_DIRECTOR_FINAL_SET_CHANGE,
  ACTION_PAYMENT_RELEASE,
  ACTION_LETTER_WORK_ORDER,
  ACTION_LETTER_LOI,
  ACTION_LETTER_PURCHASE_ORDER,
  ACTION_FINAL_SETTLEMENT,
  // HR proposes, the Director countersigns (021 FR-016). One level, because there is exactly one
  // approver in that sentence.
  ACTION_EXIT_CLEARANCE_WAIVER,
];
