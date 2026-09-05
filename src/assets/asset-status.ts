import { BadRequestException } from '@nestjs/common';
import { AssetStatus } from '@prisma/client';

/**
 * The asset status machine (spec FR-007).
 *
 * Every transition in the module goes through `assertTransition` — nothing writes
 * `Asset.status` directly. The spec asks for the rejection to *name the permitted
 * transitions*, which is the part that makes this worth a table rather than a
 * scattering of `if` statements: a caller who tried to dispatch an allocated asset
 * gets told what they can do with it instead of being told only what they cannot.
 *
 * The edges, and why each exists:
 *
 *   not_in_service → idle          its capitalisation date arrived
 *   idle → allocated               posted to a project site (US3)
 *   idle → in_transit              dispatched to another site (US5)
 *   idle → under_repair            an inspection found a fault (US6)
 *   idle → scrapped                condemned (US6, FR-018)
 *   allocated → idle               returned in a healthy grade (US3)
 *   allocated → under_repair       returned damaged (FR-015)
 *   allocated → scrapped           returned in a scrap grade (FR-015)
 *   in_transit → idle              receipt acknowledged, or the transfer cancelled
 *   under_repair → idle            the repair closed (US6)
 *   under_repair → scrapped        the repair concluded it is not worth fixing
 *
 * `scrapped` is terminal by design: an asset that has been disposed of does not come
 * back, and an entry that lets it would make the disposal date a lie. Correcting a
 * mistaken condemnation is a data-fix, not a workflow step, and it should be as
 * awkward as it sounds.
 *
 * There is deliberately no `allocated → in_transit` edge (US5 scenario 2 requires the
 * 409): moving an asset that someone is still accountable for would leave custody
 * pointing at a site the asset is no longer at, which is exactly the disagreement
 * FR-010 exists to prevent.
 */
export const ASSET_TRANSITIONS: Readonly<Record<AssetStatus, AssetStatus[]>> = {
  [AssetStatus.not_in_service]: [AssetStatus.idle],
  [AssetStatus.idle]: [
    AssetStatus.allocated,
    AssetStatus.in_transit,
    AssetStatus.under_repair,
    AssetStatus.scrapped,
  ],
  [AssetStatus.allocated]: [
    AssetStatus.idle,
    AssetStatus.under_repair,
    AssetStatus.scrapped,
  ],
  [AssetStatus.in_transit]: [AssetStatus.idle],
  [AssetStatus.under_repair]: [AssetStatus.idle, AssetStatus.scrapped],
  [AssetStatus.scrapped]: [],
};

/** Statuses an asset may be allocated, dispatched, or requested from. */
export const AVAILABLE_STATUSES: readonly AssetStatus[] = [AssetStatus.idle];

/**
 * Statuses a reminder may fire against (spec FR-027).
 *
 * Everything except `scrapped`: a disposed asset's expired insurance is not a task
 * anyone should be chased about.
 */
export const REMINDABLE_STATUSES: readonly AssetStatus[] = [
  AssetStatus.not_in_service,
  AssetStatus.idle,
  AssetStatus.allocated,
  AssetStatus.in_transit,
  AssetStatus.under_repair,
];

/** Whether a move is on the machine. A no-op move (`from === to`) is allowed, so a
 * caller re-applying the same status is idempotent rather than an error. */
export function canTransition(from: AssetStatus, to: AssetStatus): boolean {
  return from === to || ASSET_TRANSITIONS[from].includes(to);
}

/**
 * Guards a status change, naming what *is* permitted when it refuses (spec FR-007).
 *
 * `assetCode` rather than the id in the message: the person reading it is holding a
 * label with the code on it, and a cuid tells them nothing.
 */
export function assertTransition(
  from: AssetStatus,
  to: AssetStatus,
  assetCode: string,
): void {
  if (canTransition(from, to)) return;

  const permitted = ASSET_TRANSITIONS[from];
  throw new BadRequestException(
    permitted.length === 0
      ? `${assetCode} is ${from}, which is final — no further status change is possible.`
      : `${assetCode} cannot go from ${from} to ${to}. ` +
        `From ${from} it may become: ${permitted.join(', ')}.`,
  );
}
