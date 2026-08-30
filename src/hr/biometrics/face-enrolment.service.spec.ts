import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConsentMethod, FaceEnrolmentStatus } from '@prisma/client';
import { createPrismaMock } from '../../settings/testing/prisma-mock';
import {
  BiometricsService,
  FACE_DESCRIPTOR_LENGTH,
  FaceMatch,
  NoFaceDetectedError,
  euclideanDistance,
} from './biometrics.service';
import { FaceEnrolmentService, Caller } from './face-enrolment.service';

/**
 * A deterministic stand-in for face-api.
 *
 * Enrolment gating — photo counts, consent, already-enrolled — is policy logic that
 * has nothing to do with inference, so testing it against real models would only
 * add minutes of runtime and a dependency on committing photographs of real people
 * to the repository.
 */
class FakeBiometrics extends BiometricsService {
  public failWithNoFace = false;

  async computeDescriptor(photos: Buffer[]): Promise<Float32Array> {
    if (this.failWithNoFace) {
      throw new NoFaceDetectedError(0);
    }
    return Float32Array.from(
      { length: FACE_DESCRIPTOR_LENGTH },
      () => photos.length / 10,
    );
  }
  compareDescriptors(a: Float32Array, b: Float32Array): FaceMatch {
    const distance = euclideanDistance(a, b);
    return { matched: distance <= 0.6, distance };
  }
}

/** A 1x1 JPEG — enough to pass the magic-number check in decodePhotoPayload. */
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const photos = (n: number) => Array.from({ length: n }, () => JPEG_BASE64);

describe('FaceEnrolmentService', () => {
  const employee = { id: 'emp-1', companyId: 'co-1', siteId: 's-1' };
  const caller: Caller = {
    userId: 'user-1',
    companyId: 'co-1',
    ipAddress: '127.0.0.1',
    rls: { isSuperAdmin: false, companyId: 'co-1' },
  };

  let biometrics: FakeBiometrics;
  let storage: {
    put: jest.Mock;
    deleteMany: jest.Mock;
    get: jest.Mock;
    delete: jest.Mock;
  };
  let auditLog: { record: jest.Mock };

  const build = (existingEnrolment: unknown = null) => {
    biometrics = new FakeBiometrics();
    storage = {
      put: jest.fn().mockResolvedValue('face-enrolment/ref-1'),
      deleteMany: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      delete: jest.fn(),
    };
    auditLog = { record: jest.fn().mockResolvedValue(undefined) };

    const prisma = createPrismaMock({
      faceEnrolment: {
        findUnique: jest.fn().mockResolvedValue(existingEnrolment),
        upsert: jest.fn().mockImplementation(({ create }: never) => ({
          id: 'enr-1',
          ...(create as Record<string, unknown>),
        })),
        update: jest.fn().mockResolvedValue({
          id: 'enr-1',
          status: FaceEnrolmentStatus.not_enrolled,
        }),
      },
      reEnrolmentRequest: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    });

    const employees = {
      requireByUserId: jest.fn().mockResolvedValue(employee),
    };
    const images = {
      // Identity transforms: compression is sharp's job and is covered elsewhere.
      compressEnrolmentPhoto: jest.fn(async (b: Buffer) => b),
      compressPunchPhoto: jest.fn(async (b: Buffer) => b),
      decodeToRaw: jest.fn(),
    };
    const configService = {
      get: () => ({
        faceMatch: {
          distanceThreshold: 0.6,
          minEnrolmentPhotos: 3,
          maxEnrolmentPhotos: 5,
        },
      }),
    };

    const service = new FaceEnrolmentService(
      prisma as never,
      employees as never,
      biometrics,
      images as never,
      storage as never,
      auditLog as never,
      configService as never,
    );
    return { service, prisma };
  };

  describe('enrol', () => {
    it('enrols from the minimum number of photos', async () => {
      const { service } = build();
      const result = await service.enrol(
        caller,
        photos(3),
        ConsentMethod.digital,
      );

      expect(result.status).toBe(FaceEnrolmentStatus.enrolled);
      expect(result.enrolledAt).not.toBeNull();
      // One stored blob per submitted photo.
      expect(storage.put).toHaveBeenCalledTimes(3);
    });

    it('rejects fewer photos than the configured minimum', async () => {
      const { service } = build();
      await expect(
        service.enrol(caller, photos(2), ConsentMethod.digital),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects more photos than the configured maximum', async () => {
      const { service } = build();
      await expect(
        service.enrol(caller, photos(6), ConsentMethod.digital),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an already-enrolled employee with 409', async () => {
      // Re-enrolment is approval-gated; a plain POST must not route around it.
      const { service } = build({
        id: 'enr-1',
        status: FaceEnrolmentStatus.enrolled,
        photoRefs: ['old-ref'],
      });
      await expect(
        service.enrol(caller, photos(3), ConsentMethod.digital),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('surfaces an undetectable face as a 400', async () => {
      const { service } = build();
      biometrics.failWithNoFace = true;
      await expect(
        service.enrol(caller, photos(3), ConsentMethod.digital),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a payload that is not an image', async () => {
      const { service } = build();
      await expect(
        service.enrol(
          caller,
          ['bm90IGFuIGltYWdl', 'bm90IGFuIGltYWdl', 'bm90IGFuIGltYWdl'],
          ConsentMethod.digital,
        ),
      ).rejects.toThrow(/not a recognised image/);
    });

    it('never writes the descriptor or photo refs into the audit log', async () => {
      // An audit trail of biometric access must not become a second copy of it.
      const { service } = build();
      await service.enrol(caller, photos(3), ConsentMethod.digital);

      const changes = auditLog.record.mock.calls[0][0].changes;
      expect(changes).toEqual({
        photoCount: 3,
        consentMethod: ConsentMethod.digital,
      });
      expect(JSON.stringify(changes)).not.toContain('face-enrolment/');
    });
  });

  describe('withdrawConsent', () => {
    it('deletes the stored photos and reverts to not_enrolled', async () => {
      const { service } = build({
        id: 'enr-1',
        status: FaceEnrolmentStatus.enrolled,
        photoRefs: ['ref-a', 'ref-b'],
      });
      const result = await service.withdrawConsent(caller);

      expect(result.status).toBe(FaceEnrolmentStatus.not_enrolled);
      expect(result.enrolledAt).toBeNull();
      expect(storage.deleteMany).toHaveBeenCalledWith(['ref-a', 'ref-b']);
    });

    it('is idempotent when nothing is enrolled', async () => {
      const { service } = build(null);
      const result = await service.withdrawConsent(caller);

      expect(result.status).toBe(FaceEnrolmentStatus.not_enrolled);
      expect(storage.deleteMany).not.toHaveBeenCalled();
    });

    it('auto-closes any pending re-enrolment request', async () => {
      const { service, prisma } = build({
        id: 'enr-1',
        status: FaceEnrolmentStatus.enrolled,
        photoRefs: [],
      });
      await service.withdrawConsent(caller);

      expect(prisma.tx.reEnrolmentRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { employeeId: 'emp-1', status: 'pending' },
        }),
      );
    });
  });
});
