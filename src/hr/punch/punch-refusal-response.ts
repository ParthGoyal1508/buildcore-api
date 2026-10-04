import { UnprocessableEntityException } from '@nestjs/common';
import { PunchRefusalReason } from '@prisma/client';

/**
 * The stable code a refused punch returns (020 FR-013, plan D18).
 *
 * **422, not 400, 403 or 409.** The request is well-formed, so not 400. The caller is entitled to
 * punch, so not 403 — and a 403 would tell a worker standing in the wrong place that they lack
 * permission, sending them to an administrator for a problem solved by walking. The day's state is
 * irrelevant, so not 409. What happened is that a well-formed request from an authorised caller
 * could not be processed on its own terms, which is what 422 is for.
 *
 * `satisfies Record<PunchRefusalReason, ...>` is load-bearing: adding a refusal reason to the enum
 * without giving it a code is a compile error here rather than an `undefined` reaching a worker's
 * phone as the reason their punch failed.
 */
export const PUNCH_REFUSAL_CODES = {
  [PunchRefusalReason.outside_geofence]: 'PUNCH_REFUSED_LOCATION',
  [PunchRefusalReason.unlocatable]: 'PUNCH_REFUSED_UNLOCATABLE',
  // FR-012c. One code for both face reasons, deliberately. The advice is identical — retake the
  // photo — and the distinction between "no face in the picture" and "a face that is not yours"
  // is a pattern worth detecting on our side, not a difference the worker can act on. They are
  // still separate values in `PunchRefusalReason`, so the log keeps them apart.
  [PunchRefusalReason.face_mismatch]: 'PUNCH_REFUSED_FACE',
  [PunchRefusalReason.no_face_detected]: 'PUNCH_REFUSED_FACE',
} as const satisfies Record<PunchRefusalReason, string>;

/**
 * What the worker is told, by reason.
 *
 * `unlocatable` and `outside_geofence` must never collapse into one message. "You are not where you
 * should be" and "your phone cannot tell where you are" call for opposite actions, and a single
 * message tells a worker standing in exactly the right place to go somewhere else.
 */
const PUNCH_REFUSAL_MESSAGES = {
  [PunchRefusalReason.outside_geofence]:
    'You are too far from your assigned site for this punch to be accepted. Move to the site and try again.',
  [PunchRefusalReason.unlocatable]:
    'Your phone could not work out where you are accurately enough to punch. Step outside or somewhere with a clearer view of the sky, then try again.',
  [PunchRefusalReason.face_mismatch]:
    'This photo could not be matched to your enrolled face. Retake it in better light, facing the camera straight on.',
  [PunchRefusalReason.no_face_detected]:
    'This photo could not be matched to your enrolled face. Retake it in better light, facing the camera straight on.',
} as const satisfies Record<PunchRefusalReason, string>;

/**
 * Builds the 422 a refused punch returns (FR-015).
 *
 * **This response is the only place the worker learns what happened.** Under FR-013d nothing is
 * written to attendance, so unlike every other failure in this service there is no record to go back
 * to afterwards — the day will read as a day with no punch. That is why the reason travels in the
 * body rather than only in a log, and why `GET /my/punch/refusals` exists as its companion.
 */
export function punchRefusedException(
  reason: PunchRefusalReason,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: PUNCH_REFUSAL_CODES[reason],
    message: PUNCH_REFUSAL_MESSAGES[reason],
    // The enum value as well as the code. The code is what a client branches on; this is what an
    // administrator reading a support ticket needs, and `PUNCH_REFUSED_FACE` alone cannot tell them
    // whether the photo had no face in it.
    reason,
  });
}
