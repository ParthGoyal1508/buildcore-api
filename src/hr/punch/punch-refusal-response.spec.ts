import { LabourPunchRefusalReason, PunchRefusalReason } from '@prisma/client';

import { labourPunchRefused } from '../../labour/attendance/labour-punch-refusal';
import {
  formatDistance,
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

  // 057: every refusal says what was measured, not only that it failed.
  describe('measured justification', () => {
    const messageOf = (e: { getResponse(): unknown }) =>
      (e.getResponse() as { message: string }).message;

    it('quotes the distance and the fence it was judged against', () => {
      const message = messageOf(
        punchRefusedException(PunchRefusalReason.outside_geofence, {
          distanceMeters: 847,
          allowedMeters: 230,
        }),
      );
      expect(message).toContain('about 850 m');
      expect(message).toContain('within 230 m');
    });

    it('quotes the accuracy against the threshold, and says to switch GPS on', () => {
      const message = messageOf(
        punchRefusedException(PunchRefusalReason.unlocatable, {
          accuracyMeters: 312.4,
          accuracyMaxMeters: 100,
        }),
      );
      expect(message).toContain('about 312 m');
      expect(message).toContain('100 m or better');
      expect(message).toMatch(/Location \(GPS\)/);
    });

    it('falls back to a plain sentence when nothing was measured', () => {
      expect(
        messageOf(punchRefusedException(PunchRefusalReason.outside_geofence)),
      ).toMatch(/too far/);
    });

    it('tells "no face" apart from "not your face", under one code', () => {
      const noFace = punchRefusedException(PunchRefusalReason.no_face_detected);
      const mismatch = punchRefusedException(PunchRefusalReason.face_mismatch);
      expect(messageOf(noFace)).toMatch(/No face could be seen/);
      expect(messageOf(mismatch)).toMatch(/does not match your enrolled face/);
      expect(PUNCH_REFUSAL_CODES[PunchRefusalReason.no_face_detected]).toBe(
        PUNCH_REFUSAL_CODES[PunchRefusalReason.face_mismatch],
      );
    });

    it('carries the figures in the body for a client to render', () => {
      const detail = { distanceMeters: 1200, allowedMeters: 200 };
      expect(
        punchRefusedException(
          PunchRefusalReason.outside_geofence,
          detail,
        ).getResponse(),
      ).toMatchObject({ code: 'PUNCH_REFUSED_LOCATION', detail });
    });

    it('words the labour refusal for the supervisor with the same numbers', () => {
      const message = messageOf(
        labourPunchRefused(LabourPunchRefusalReason.outside_geofence, {
          distanceMeters: 2430,
          allowedMeters: 150,
        }),
      );
      expect(message).toContain('about 2.4 km from this site');
      expect(message).toContain('within 150 m');
    });

    it('rounds distances to what GPS can honestly claim', () => {
      expect(formatDistance(3)).toBe('10 m');
      expect(formatDistance(994)).toBe('990 m');
      expect(formatDistance(1000)).toBe('1.0 km');
    });
  });
});
