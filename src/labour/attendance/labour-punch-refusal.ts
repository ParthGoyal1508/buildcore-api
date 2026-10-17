import { UnprocessableEntityException } from '@nestjs/common';
import { LabourPunchRefusalReason } from '@prisma/client';

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

/** Written for the supervisor holding the phone, not the labour in the photo. */
const MESSAGES = {
  [LabourPunchRefusalReason.outside_geofence]:
    'You are too far from this site for attendance to be marked. Move to the site and try again.',
  [LabourPunchRefusalReason.unlocatable]:
    'Your phone could not work out where you are accurately enough. Step outside or somewhere with a clearer view of the sky, then try again.',
  [LabourPunchRefusalReason.face_mismatch]:
    'This photo does not match the face registered for this labour, so attendance was not marked. Check you picked the right person, then retake the photo in good light, facing the camera.',
  [LabourPunchRefusalReason.no_face_detected]:
    'No face could be seen in this photo. Retake it in good light with the face filling the frame.',
} as const satisfies Record<LabourPunchRefusalReason, string>;

export function labourPunchRefused(
  reason: LabourPunchRefusalReason,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: LABOUR_PUNCH_REFUSAL_CODES[reason],
    message: MESSAGES[reason],
    reason,
  });
}
