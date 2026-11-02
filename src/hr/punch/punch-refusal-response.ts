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
  // FR-012c. One code for both face reasons, deliberately: a client offers the same action — retake
  // the photo — for either. The messages differ (057) and so do the `PunchRefusalReason` values, so
  // the worker reads which one happened and the log keeps them apart.
  [PunchRefusalReason.face_mismatch]: 'PUNCH_REFUSED_FACE',
  [PunchRefusalReason.no_face_detected]: 'PUNCH_REFUSED_FACE',
} as const satisfies Record<PunchRefusalReason, string>;

/**
 * What was measured when a punch was refused (057). Each refusal says *why* in numbers the worker
 * can act on — how far they stood from the fence, how vague the fix was — rather than only that it
 * failed, and the same figures travel in the body so a client can show them without parsing text.
 *
 * Every field is optional because each reason uses a different subset: a face refusal has no
 * distance worth quoting, and an unlocatable fix has no distance worth trusting.
 */
export interface PunchRefusalDetail {
  /** Distance from the site's centre to the reported position. */
  distanceMeters?: number;
  /** The fence the punch was judged against: the site radius plus any accuracy allowance. */
  allowedMeters?: number;
  /** The accuracy radius the phone reported. */
  accuracyMeters?: number;
  /** The company's accuracy threshold — a fix vaguer than this cannot be located. */
  accuracyMaxMeters?: number;
}

/** "850 m" under a kilometre (rounded to 10 m — finer is false precision for GPS), "2.4 km" above. */
export function formatDistance(meters: number): string {
  return meters < 1000
    ? `${Math.max(10, Math.round(meters / 10) * 10)} m`
    : `${(meters / 1000).toFixed(1)} km`;
}

/**
 * The location clauses, shared by the employee and labour messages so the numbers read identically
 * on both screens. `who`/`where` adapt the sentence to who is holding the phone.
 */
export function outsideFenceMessage(
  detail: PunchRefusalDetail,
  where: string,
): string {
  const { distanceMeters, allowedMeters } = detail;
  if (distanceMeters === undefined || allowedMeters === undefined) {
    return `You are too far from ${where} for attendance to be accepted. Move to the site and try again.`;
  }
  return (
    `You are about ${formatDistance(
      distanceMeters,
    )} from ${where}, and attendance is accepted only ` +
    `within ${formatDistance(
      allowedMeters,
    )} of it. Move to the site and try again.`
  );
}

export function unlocatableMessage(detail: PunchRefusalDetail): string {
  const { accuracyMeters, accuracyMaxMeters } = detail;
  const measured =
    accuracyMeters !== undefined && accuracyMaxMeters !== undefined
      ? `Your phone could only place you within about ${Math.round(
          accuracyMeters,
        )} m, and ` +
        `attendance needs a location accurate to ${Math.round(
          accuracyMaxMeters,
        )} m or better. `
      : 'Your phone could not work out where you are accurately enough. ';
  return (
    measured +
    'Check that Location (GPS) is switched on, step outside or near a window, wait a few seconds, ' +
    'then try again.'
  );
}

/**
 * What the worker is told, by reason.
 *
 * `unlocatable` and `outside_geofence` must never collapse into one message. "You are not where you
 * should be" and "your phone cannot tell where you are" call for opposite actions, and a single
 * message tells a worker standing in exactly the right place to go somewhere else.
 *
 * The two face reasons share a code but, since 057, not a message: "no face in the picture" is
 * fixed by framing, "a face that is not yours" is not, and the worker is owed the difference.
 */
const PUNCH_REFUSAL_MESSAGES = {
  [PunchRefusalReason.outside_geofence]: (d: PunchRefusalDetail) =>
    outsideFenceMessage(d, 'your assigned site'),
  [PunchRefusalReason.unlocatable]: unlocatableMessage,
  [PunchRefusalReason.face_mismatch]: () =>
    'The face in this photo does not match your enrolled face, so the punch was not recorded. ' +
    'Retake it in good light, facing the camera straight on.',
  [PunchRefusalReason.no_face_detected]: () =>
    'No face could be seen in this photo, so the punch was not recorded. Retake it in good light ' +
    'with your face filling the frame.',
} as const satisfies Record<
  PunchRefusalReason,
  (detail: PunchRefusalDetail) => string
>;

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
  detail: PunchRefusalDetail = {},
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: PUNCH_REFUSAL_CODES[reason],
    message: PUNCH_REFUSAL_MESSAGES[reason](detail),
    // The enum value as well as the code. The code is what a client branches on; this is what an
    // administrator reading a support ticket needs, and `PUNCH_REFUSED_FACE` alone cannot tell them
    // whether the photo had no face in it.
    reason,
    detail,
  });
}
