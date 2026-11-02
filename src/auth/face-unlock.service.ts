import {
  ForbiddenException,
  HttpException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../common/prisma/rls-context';
import {
  BiometricsService,
  NoFaceDetectedError,
} from '../hr/biometrics/biometrics.service';
import { ImageProcessingService } from '../hr/biometrics/image-processing.service';
import {
  LivenessService,
  livenessMessage,
  livenessSubject,
} from '../hr/biometrics/liveness.service';
import { AuditLogService } from './audit-log.service';
import { AuthenticatedUser } from './authenticated-user';
import {
  ConfirmationPurpose,
  PasswordConfirmationService,
} from './password-confirmation.service';

export const FACE_NOT_RECOGNISED = 'FACE_NOT_RECOGNISED';
export const FACE_UNLOCK_NOT_SET_UP = 'FACE_UNLOCK_NOT_SET_UP';

/**
 * Face in place of the password before a sensitive act (054, 2026-11-01 — the client: "instead
 * of password can we give face unlock?", with the password kept as the fallback).
 *
 * A face match mints the same ten-minute confirmation `confirmPassword` does, marked `face`, so
 * the act's endpoint needs no change. The match runs here, on the server, with the attendance
 * matcher — a browser cannot claim a match it did not get.
 *
 * Registering or removing the face itself needs a **password** confirmation: a face that passed
 * once cannot re-register itself or lock the owner out.
 *
 * **Live faces only (057).** Registering and confirming both follow a server-issued head-turn
 * challenge, judged as attendance judges a punch — the head turned as asked, the same person in
 * every frame, and the anti-spoof models scoring it live — so a photo of the owner held up to the
 * camera is refused. Before 057 one still frame was matched, and a photo would have passed. A mismatch is audited as a failed sign-in but does not count toward the account
 * lockout, so bad lighting cannot lock an administrator out of signing in; the controller's rate
 * limit bounds the guessing instead.
 */
@Injectable()
export class FaceUnlockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly biometrics: BiometricsService,
    private readonly images: ImageProcessingService,
    private readonly confirmation: PasswordConfirmationService,
    private readonly audit: AuditLogService,
    private readonly liveness: LivenessService,
  ) {}

  async status(
    caller: AuthenticatedUser,
    purpose: ConfirmationPurpose,
  ): Promise<{ enrolled: boolean; enrolledAt: string | null }> {
    this.assertMayConfirm(caller, purpose);
    const row = await this.find(caller.id);
    return {
      enrolled: row !== null,
      enrolledAt: row?.enrolledAt.toISOString() ?? null,
    };
  }

  async enrol(
    caller: AuthenticatedUser,
    purpose: ConfirmationPurpose,
    token: string | string[] | undefined,
    challengeId: string,
    frames: Buffer[],
    ipAddress: string,
  ): Promise<{ enrolled: boolean; enrolledAt: string | null }> {
    this.assertMayConfirm(caller, purpose);
    // The password first: a capture is not spent on a request that was never going to be allowed.
    this.confirmation.assertConfirmed(token, caller.id, purpose, {
      passwordOnly: true,
    });
    await this.liveness.assertLive(
      challengeId,
      livenessSubject(caller.id, 'unlock-enrolment'),
      frames,
      { subject: 'your', noFaceCode: 'NO_FACE' },
    );
    // Every frame of the capture goes into the template, as for attendance enrolment: the two slight
    // turns give it the angles a confirmation will actually be taken at.
    const compressed = await Promise.all(
      frames.map((frame) => this.images.compressEnrolmentPhoto(frame)),
    );
    let descriptor: Float32Array;
    try {
      descriptor = await this.biometrics.computeDescriptor(compressed);
    } catch (error) {
      if (error instanceof NoFaceDetectedError) {
        throw new HttpException(
          { statusCode: 400, code: 'NO_FACE', message: error.message },
          400,
        );
      }
      throw error;
    }
    const bytes = this.biometrics.serializeDescriptor(descriptor);
    const row = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.userFaceUnlock.upsert({
          where: { userId: caller.id },
          create: { userId: caller.id, descriptor: bytes },
          update: { descriptor: bytes, enrolledAt: new Date() },
        }),
    );
    await this.record(
      caller,
      AuditAction.UPDATE,
      'face_unlock_enrolled',
      purpose,
      ipAddress,
    );
    return { enrolled: true, enrolledAt: row.enrolledAt.toISOString() };
  }

  async remove(
    caller: AuthenticatedUser,
    purpose: ConfirmationPurpose,
    token: string | string[] | undefined,
    ipAddress: string,
  ): Promise<{ enrolled: boolean; enrolledAt: string | null }> {
    this.assertMayConfirm(caller, purpose);
    this.confirmation.assertConfirmed(token, caller.id, purpose, {
      passwordOnly: true,
    });
    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.userFaceUnlock.deleteMany({ where: { userId: caller.id } }),
    );
    await this.record(
      caller,
      AuditAction.DELETE,
      'face_unlock_removed',
      purpose,
      ipAddress,
    );
    return { enrolled: false, enrolledAt: null };
  }

  async confirm(
    caller: AuthenticatedUser,
    purpose: ConfirmationPurpose,
    challengeId: string,
    frames: Buffer[],
    ipAddress: string,
  ): Promise<{ confirmationToken: string; expiresAt: string }> {
    this.assertMayConfirm(caller, purpose);
    if (caller.lockedUntil && caller.lockedUntil > new Date()) {
      throw new HttpException(
        {
          message: `Account temporarily locked. Try again after ${caller.lockedUntil.toISOString()}.`,
        },
        423,
      );
    }
    const row = await this.find(caller.id);
    if (!row) {
      throw new ForbiddenException({
        statusCode: 403,
        code: FACE_UNLOCK_NOT_SET_UP,
        message: 'Face unlock is not set up. Use your password.',
      });
    }

    const steps = await this.liveness.consume(
      challengeId,
      livenessSubject(caller.id, 'unlock-confirm'),
    );
    const { straight, failure } = await this.liveness.judge(steps, frames);
    const noFace = failure?.kind === 'no_face' && failure.step === 'straight';

    // Not a live person: refused before any match is attempted, and saying which check failed.
    if (failure && !noFace) {
      await this.recordFailure(caller, purpose, ipAddress, {
        liveness: failure.kind,
      });
      throw new UnprocessableEntityException({
        code: 'LIVENESS_FAILED',
        message: livenessMessage(failure, 'your'),
        reason: failure.kind,
        step: failure.step,
      });
    }

    const candidate = noFace ? null : straight?.descriptor ?? null;
    const match = candidate
      ? this.biometrics.compareDescriptors(
          candidate,
          this.biometrics.deserializeDescriptor(Buffer.from(row.descriptor)),
        )
      : null;

    if (!match?.matched) {
      await this.recordFailure(caller, purpose, ipAddress, {
        distance: match?.distance ?? null,
      });
      throw new ForbiddenException({
        statusCode: 403,
        code: FACE_NOT_RECOGNISED,
        message: candidate
          ? 'Face not recognised. Try again, or use your password.'
          : 'No face was found in the picture. Face the camera in good light and try again.',
      });
    }

    await this.record(
      caller,
      AuditAction.READ,
      'face_confirmed',
      purpose,
      ipAddress,
    );
    return this.confirmation.issue(caller.id, purpose, 'face');
  }

  /** As `confirmPassword`: no proving who you are for an act you could not perform anyway. */
  private assertMayConfirm(
    caller: AuthenticatedUser,
    purpose: ConfirmationPurpose,
  ): void {
    const required = this.confirmation.requiredPermission(purpose);
    if (!required || !caller.permissions.includes(required)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'CONFIRMATION_NOT_PERMITTED',
        message:
          'Your role does not include the setting this confirmation is for.',
      });
    }
  }

  /** A failed face confirmation, audited as a failed sign-in (never counted toward the lockout). */
  private recordFailure(
    caller: AuthenticatedUser,
    purpose: ConfirmationPurpose,
    ipAddress: string,
    detail: Record<string, string | number | null>,
  ): Promise<void> {
    return this.audit.recordAuthEvent(AuditEntityType.LOGIN_FAILURE, {
      accountId: caller.id,
      companyId: caller.companyId,
      ipAddress,
      changes: { event: 'face_confirmation_failed', purpose, ...detail },
    });
  }

  private find(userId: string) {
    return withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.userFaceUnlock.findUnique({ where: { userId } }),
    );
  }

  private record(
    caller: AuthenticatedUser,
    action: AuditAction,
    event: string,
    purpose: ConfirmationPurpose,
    ipAddress: string,
  ): Promise<void> {
    return this.audit.record({
      entityType: AuditEntityType.USER_ACCOUNT,
      action,
      entityId: caller.id,
      accountId: caller.id,
      companyId: caller.companyId,
      ipAddress,
      changes: { event, purpose },
    });
  }
}
