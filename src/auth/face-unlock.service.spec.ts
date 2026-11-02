import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Permission } from '@prisma/client';

import { FaceUnlockService } from './face-unlock.service';
import { PasswordConfirmationService } from './password-confirmation.service';

const FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PUNCH_STEPS = ['straight', 'left', 'right'];
const FRAMES = [FRAME, FRAME, FRAME];
const ENROL_FRAMES = [FRAME, FRAME, FRAME, FRAME];

/** 054: a face stands in for the password, but never re-registers itself. */
describe('FaceUnlockService', () => {
  const caller = {
    id: 'u1',
    companyId: 'c1',
    permissions: [Permission.CROSS_COMPANY_ACCESS],
    lockedUntil: null,
  } as never;
  const confirmation = new PasswordConfirmationService({
    get: () => ({ jwtAccessSecret: 'test-secret' }),
  } as never);

  function build(
    matched: boolean,
    stored = true,
    failure: { kind: string; step?: string } | null = null,
  ) {
    const userFaceUnlock = {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          stored
            ? { descriptor: Buffer.alloc(512), enrolledAt: new Date() }
            : null,
        ),
      upsert: jest.fn().mockResolvedValue({ enrolledAt: new Date() }),
      deleteMany: jest.fn(),
    };
    const prisma = {
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
        cb({ userFaceUnlock, $executeRaw: jest.fn() }),
      ),
    } as never;
    const biometrics = {
      computeDescriptor: jest.fn().mockResolvedValue(new Float32Array(128)),
      compareDescriptors: jest.fn().mockReturnValue({ matched, distance: 0.3 }),
      serializeDescriptor: jest.fn().mockReturnValue(Buffer.alloc(512)),
      deserializeDescriptor: jest.fn().mockReturnValue(new Float32Array(128)),
    } as never;
    const images = {
      compressEnrolmentPhoto: jest.fn(async (b: Buffer) => b),
    } as never;
    const audit = {
      record: jest.fn(),
      recordAuthEvent: jest.fn(),
    };
    // 057: the head-turn verdict is LivenessService's own (tested there); here only what the
    // unlock does with it.
    const liveness = {
      consume: jest.fn().mockResolvedValue(PUNCH_STEPS),
      judge: jest.fn().mockResolvedValue({
        straight: { descriptor: new Float32Array(128) },
        failure,
      }),
      assertLive: jest.fn().mockImplementation(async () => {
        if (failure) {
          throw new UnprocessableEntityException({ code: 'LIVENESS_FAILED' });
        }
      }),
    };
    return {
      service: new FaceUnlockService(
        prisma,
        biometrics,
        images,
        confirmation,
        audit as never,
        liveness as never,
      ),
      audit,
      liveness,
      userFaceUnlock,
    };
  }

  it('turns a matching face into a confirmation the act accepts', async () => {
    const { service } = build(true);
    const { confirmationToken } = await service.confirm(
      caller,
      'cash-visibility',
      'ch-1',
      FRAMES,
      '::1',
    );
    expect(() =>
      confirmation.assertConfirmed(confirmationToken, 'u1', 'cash-visibility'),
    ).not.toThrow();
  });

  it('refuses a face that does not match, and audits it', async () => {
    const { service, audit } = build(false);
    await expect(
      service.confirm(caller, 'cash-visibility', 'ch-1', FRAMES, '::1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.recordAuthEvent).toHaveBeenCalled();
  });

  it('refuses when no face is registered', async () => {
    const { service } = build(true, false);
    await expect(
      service.confirm(caller, 'cash-visibility', 'ch-1', FRAMES, '::1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('registers a face only on a password confirmation', async () => {
    const { service, userFaceUnlock } = build(true);
    const face = confirmation.issue('u1', 'cash-visibility', 'face');
    await expect(
      service.enrol(
        caller,
        'cash-visibility',
        face.confirmationToken,
        'ch-1',
        ENROL_FRAMES,
        '::1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(userFaceUnlock.upsert).not.toHaveBeenCalled();

    const password = confirmation.issue('u1', 'cash-visibility');
    await service.enrol(
      caller,
      'cash-visibility',
      password.confirmationToken,
      'ch-1',
      ENROL_FRAMES,
      '::1',
    );
    expect(userFaceUnlock.upsert).toHaveBeenCalled();
  });

  it('refuses a photo held up to the camera before matching it, and audits why (057)', async () => {
    // A still photo of the owner matches — the head turn is what gives it away.
    const { service, audit, liveness } = build(true, true, {
      kind: 'did_not_turn',
      step: 'left',
    });
    await expect(
      service.confirm(caller, 'cash-visibility', 'ch-1', FRAMES, '::1'),
    ).rejects.toMatchObject({
      response: { code: 'LIVENESS_FAILED', reason: 'did_not_turn' },
    });
    expect(liveness.consume).toHaveBeenCalledWith('ch-1', 'u1:unlock-confirm:');
    expect(audit.recordAuthEvent.mock.calls[0][1].changes).toMatchObject({
      event: 'face_confirmation_failed',
      liveness: 'did_not_turn',
    });
  });

  it('reads no face in the straight frame as "no face found", not as a spoof', async () => {
    const { service } = build(true, true, {
      kind: 'no_face',
      step: 'straight',
    });
    await expect(
      service.confirm(caller, 'cash-visibility', 'ch-1', FRAMES, '::1'),
    ).rejects.toMatchObject({
      response: { code: 'FACE_NOT_RECOGNISED', message: /No face was found/ },
    });
  });

  it('spends no challenge when face unlock is not set up', async () => {
    const { service, liveness } = build(true, false);
    await expect(
      service.confirm(caller, 'cash-visibility', 'ch-1', FRAMES, '::1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(liveness.consume).not.toHaveBeenCalled();
  });

  it('registers only a live face, on its own enrolment challenge (057)', async () => {
    const password = confirmation.issue('u1', 'cash-visibility');
    const live = build(true);
    await live.service.enrol(
      caller,
      'cash-visibility',
      password.confirmationToken,
      'ch-1',
      ENROL_FRAMES,
      '::1',
    );
    expect(live.liveness.assertLive).toHaveBeenCalledWith(
      'ch-1',
      'u1:unlock-enrolment:',
      ENROL_FRAMES,
      expect.anything(),
    );

    const spoof = build(true, true, { kind: 'spoof' });
    await expect(
      spoof.service.enrol(
        caller,
        'cash-visibility',
        confirmation.issue('u1', 'cash-visibility').confirmationToken,
        'ch-2',
        ENROL_FRAMES,
        '::1',
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(spoof.userFaceUnlock.upsert).not.toHaveBeenCalled();
  });
});
