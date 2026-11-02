import { UnprocessableEntityException } from '@nestjs/common';
import { LabourPunchRefusalReason } from '@prisma/client';
import {
  outsideFenceMessage,
  PunchRefusalDetail,
  unlocatableMessage,
} from '../../hr/punch/punch-refusal-response';

/**
 * The stable codes a refused labour punch returns (031). 422 for the reason
 * `punch-refusal-response.ts` gives: a well-formed request from an authorised supervisor that could
 * not be accepted on its own terms.
 */
export const LABOUR_PUNCH_REFUSAL_CODES = {
  [LabourPunchRefusalReason.outside_geofence]: 'LABOUR_PUNCH_REFUSED_LOCATION',
  [LabourPunchRefusalReason.unlocatable]: 'LABOUR_PUNCH_REFUSED_UNLOCATABLE',
  [LabourPunchRefusalReason.face_mismatch]: 'LABOUR_PUNCH_REFUSED_FACE',
  [LabourPunchRefusalReason.no_face_detected]: 'LABOUR_PUNCH_REFUSED_FACE',
} as const satisfies Record<LabourPunchRefusalReason, string>;

/**
 * Written for the supervisor holding the phone, not the labour in the photo. The location messages
 * quote what was measured (057), worded exactly as the employee's so the two screens agree.
 */
const MESSAGES = {
  [LabourPunchRefusalReason.outside_geofence]: (d: PunchRefusalDetail) =>
    outsideFenceMessage(d, 'this site'),
  [LabourPunchRefusalReason.unlocatable]: unlocatableMessage,
  [LabourPunchRefusalReason.face_mismatch]: () =>
    'This photo does not match the face registered for this labour, so attendance was not marked. Check you picked the right person, then retake the photo in good light, facing the camera.',
  [LabourPunchRefusalReason.no_face_detected]: () =>
    'No face could be seen in this photo, so attendance was not marked. Retake it in good light with the face filling the frame.',
} as const satisfies Record<
  LabourPunchRefusalReason,
  (detail: PunchRefusalDetail) => string
>;

export function labourPunchRefused(
  reason: LabourPunchRefusalReason,
  detail: PunchRefusalDetail = {},
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: LABOUR_PUNCH_REFUSAL_CODES[reason],
    message: MESSAGES[reason](detail),
    reason,
    detail,
  });
}
