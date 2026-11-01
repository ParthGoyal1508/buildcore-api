import { ForbiddenException } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { FaceUnlockService } from './face-unlock.service';
import { PasswordConfirmationService } from './password-confirmation.service';

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]).toString('base64');

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

  function build(matched: boolean, stored = true) {
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
    return {
      service: new FaceUnlockService(
        prisma,
        biometrics,
        images,
        confirmation,
        audit as never,
      ),
      audit,
      userFaceUnlock,
    };
  }

  it('turns a matching face into a confirmation the act accepts', async () => {
    const { service } = build(true);
    const { confirmationToken } = await service.confirm(
      caller,
      'cash-visibility',
      JPEG,
      '::1',
    );
    expect(() =>
      confirmation.assertConfirmed(confirmationToken, 'u1', 'cash-visibility'),
    ).not.toThrow();
  });

  it('refuses a face that does not match, and audits it', async () => {
    const { service, audit } = build(false);
    await expect(
      service.confirm(caller, 'cash-visibility', JPEG, '::1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.recordAuthEvent).toHaveBeenCalled();
  });

  it('refuses when no face is registered', async () => {
    const { service } = build(true, false);
    await expect(
      service.confirm(caller, 'cash-visibility', JPEG, '::1'),
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
        [JPEG, JPEG, JPEG],
        '::1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(userFaceUnlock.upsert).not.toHaveBeenCalled();

    const password = confirmation.issue('u1', 'cash-visibility');
    await service.enrol(
      caller,
      'cash-visibility',
      password.confirmationToken,
      [JPEG, JPEG, JPEG],
      '::1',
    );
    expect(userFaceUnlock.upsert).toHaveBeenCalled();
  });
});
