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
