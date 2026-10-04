import { PunchRefusalReason } from '@prisma/client';

import {
  PUNCH_REFUSAL_CODES,
  punchRefusedException,
} from './punch-refusal-response';

/**
 * 020 FR-013, FR-012c, plan D18.
 *
 * The exhaustiveness is already a compile error through `satisfies`, so these tests exist for the
 * things the type system cannot see: that the codes are the ones the contract names, that the two
 * location reasons stay apart, and that the two face reasons stay together.
 */
describe('punch refusal responses', () => {
  it('gives every refusal reason a code', () => {
    // A `satisfies` clause catches a *missing* key. It does not catch a key whose value was
    // copy-pasted and left empty, which would reach a worker's phone as the reason their punch
    // failed.
    for (const reason of Object.values(PunchRefusalReason)) {
      expect(PUNCH_REFUSAL_CODES[reason]).toMatch(/^PUNCH_REFUSED_[A-Z]+$/);
    }
  });

  it('keeps "outside the fence" and "cannot be located" apart', () => {
    // The distinction FR-013b exists for: one means move, the other means your phone cannot tell
    // where you are. A single code tells a worker standing in the right place to go somewhere else.
    expect(PUNCH_REFUSAL_CODES[PunchRefusalReason.outside_geofence]).not.toBe(
      PUNCH_REFUSAL_CODES[PunchRefusalReason.unlocatable],
    );
  });

  it('gives both face failures one code and keeps two reasons', () => {
    // FR-012c. Identical advice — retake the photo — so one code; different patterns worth
    // detecting, so the reason travels alongside it.
    expect(PUNCH_REFUSAL_CODES[PunchRefusalReason.no_face_detected]).toBe(
      PUNCH_REFUSAL_CODES[PunchRefusalReason.face_mismatch],
    );

    const undetectable = punchRefusedException(
      PunchRefusalReason.no_face_detected,
    );
    const mismatch = punchRefusedException(PunchRefusalReason.face_mismatch);
    expect((undetectable.getResponse() as { reason: string }).reason).toBe(
      'no_face_detected',
    );
    expect((mismatch.getResponse() as { reason: string }).reason).toBe(
      'face_mismatch',
    );
  });

  it('refuses with 422', () => {
    // Not 400 (the request is well-formed), not 403 (the caller may punch), not 409 (the day's
    // state is irrelevant). A 403 in particular would send a worker who needs to walk 50 metres to
    // an administrator instead.
    expect(
      punchRefusedException(PunchRefusalReason.outside_geofence).getStatus(),
    ).toBe(422);
  });

  it('tells the worker what to do, in a sentence', () => {
    // FR-015. This response is the only place the reason exists for them — nothing is written to
    // attendance, so there is no record to read afterwards. A bare code here would leave them with
    // nothing.
    for (const reason of Object.values(PunchRefusalReason)) {
      const { message } = punchRefusedException(reason).getResponse() as {
        message: string;
      };
      expect(message.length).toBeGreaterThan(30);
      expect(message).toMatch(/try again|Retake/);
    }
  });
});
