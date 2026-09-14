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
