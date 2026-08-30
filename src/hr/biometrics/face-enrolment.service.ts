import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  ConsentMethod,
  FaceEnrolmentStatus,
  Prisma,
  ReEnrolmentRequest,
  ReEnrolmentRequestStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import type { WorkspaceConfig } from '../../common/configs/config.interface';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { EmployeesService } from '../employees/employees.service';
import { BiometricsService, NoFaceDetectedError } from './biometrics.service';
import { ImageProcessingService } from './image-processing.service';
import { decodePhotoPayload } from './photo-payload';

/** Object-storage namespace for enrolment photos. */
const ENROLMENT_NAMESPACE = 'face-enrolment';

export interface EnrolmentStatusView {
  status: FaceEnrolmentStatus;
  enrolledAt: string | null;
  /**
   * The caller's latest re-enrolment request, or null if they have never made one.
   *
   * Returned alongside the status because `status` alone cannot distinguish the
   * three states the employee-facing screen has to tell apart: waiting on a
   * decision, refused (and why), and approved-with-an-unlock-still-usable. Without
   * this the UI would have to offer "Re-enrol Now" speculatively and discover from
   * a 403 that there was never an unlock.
   */
  reEnrolment: ReEnrolmentStateView | null;
}

export interface ReEnrolmentStateView {
  id: string;
  status: ReEnrolmentRequestStatus;
  reason: string;
  adminRemarks: string | null;
  requestedAt: string;
  decidedAt: string | null;
  unlockExpiresAt: string | null;
  /** Approved, unexpired, and unconsumed — the same three conditions
   * `completeReEnrolment` checks, so the button and the endpoint agree. */
  unlockActive: boolean;
}

/** Everything a call into this service needs about who is asking. */
export interface Caller {
  userId: string;
  companyId: string | null;
  ipAddress: string;
  rls: RlsContext;
}

/**
 * Face enrolment, consent, and withdrawal (US1).
 *
 * The employee is always resolved from the caller's own token — no method here
 * takes an employee identifier from the request (FR-028).
 */
@Injectable()
export class FaceEnrolmentService {
  private readonly workspace: WorkspaceConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
    private readonly biometrics: BiometricsService,
    private readonly images: ImageProcessingService,
    private readonly storage: StorageService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.workspace = configService.get<WorkspaceConfig>('workspace');
  }

  /**
   * The caller's enrolment status.
   *
   * Audited as a READ: Principle IV places biometric data in the same tier as
   * Aadhaar/PAN, where knowing who looked is part of the protection, not an extra.
   */
  async getStatus(caller: Caller): Promise<EnrolmentStatusView> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    const enrolment = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.faceEnrolment.findUnique({ where: { employeeId: employee.id } }),
    );
    const latestRequest = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reEnrolmentRequest.findFirst({
        where: { employeeId: employee.id },
        orderBy: { createdAt: 'desc' },
      }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.FACE_ENROLMENT,
      action: AuditAction.READ,
      entityId: enrolment?.id ?? null,
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    return {
      status: enrolment?.status ?? FaceEnrolmentStatus.not_enrolled,
      enrolledAt: enrolment?.enrolledAt?.toISOString() ?? null,
      reEnrolment: latestRequest
        ? {
            id: latestRequest.id,
            status: latestRequest.status,
            reason: latestRequest.reason,
            adminRemarks: latestRequest.adminRemarks,
            requestedAt: latestRequest.createdAt.toISOString(),
            decidedAt: latestRequest.decidedAt?.toISOString() ?? null,
            unlockExpiresAt:
              latestRequest.unlockExpiresAt?.toISOString() ?? null,
            unlockActive:
              latestRequest.status === ReEnrolmentRequestStatus.approved &&
              latestRequest.unlockConsumedAt === null &&
              latestRequest.unlockExpiresAt !== null &&
              latestRequest.unlockExpiresAt.getTime() > Date.now(),
          }
        : null,
    };
  }

  /** Enrols the caller from 3–5 photos plus recorded consent (FR-001–FR-003). */
  async enrol(
    caller: Caller,
    photos: string[],
    consentMethod: ConsentMethod,
  ): Promise<EnrolmentStatusView> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    this.assertPhotoCount(photos);

    const existing = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.faceEnrolment.findUnique({ where: { employeeId: employee.id } }),
    );
    if (existing?.status === FaceEnrolmentStatus.enrolled) {
      // 409, not an overwrite: re-enrolment is an approval-gated flow (FR-013–FR-016),
      // and letting a plain POST silently replace a template would route around it.
      throw new ConflictException(
        'Already enrolled. Request a re-enrolment to replace your face template.',
      );
    }

    // Compress first, then derive the descriptor from the same bytes that get
    // stored. Computing it from the originals instead would mean the stored photos
    // are not quite what the template was built from — a discrepancy nobody could
    // reproduce later when investigating a match failure.
    const { descriptor, photoRefs } = await this.buildTemplate(photos);

    const enrolledAt = new Date();
    const record = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.faceEnrolment.upsert({
        where: { employeeId: employee.id },
        create: {
          employeeId: employee.id,
          descriptor: this.biometrics.serializeDescriptor(descriptor),
          photoRefs,
          consentMethod,
          consentAcknowledgedAt: enrolledAt,
          enrolledAt,
          status: FaceEnrolmentStatus.enrolled,
        },
        update: {
          descriptor: this.biometrics.serializeDescriptor(descriptor),
          photoRefs,
          consentMethod,
          consentAcknowledgedAt: enrolledAt,
          enrolledAt,
          status: FaceEnrolmentStatus.enrolled,
        },
      }),
    );

    // Any photos from a previous, non-enrolled attempt are now unreferenced. Delete
    // them rather than leaving orphans: biometric data must not outlive the record
    // pointing at it (FR-026).
    if (existing?.photoRefs?.length) {
      await this.storage.deleteMany(existing.photoRefs);
    }

    await this.auditLog.record({
      entityType: AuditEntityType.FACE_ENROLMENT,
      action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
      entityId: record.id,
      // The descriptor and photo references are deliberately absent from the audit
      // payload — an audit trail of who touched biometric data must not itself
      // become a second, unencrypted copy of that data.
      changes: {
        photoCount: photoRefs.length,
        consentMethod,
      } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    return {
      status: record.status,
      enrolledAt: record.enrolledAt?.toISOString() ?? null,
      reEnrolment: null,
    };
  }

  /**
   * Withdraws consent: deletes the template and photos, reverting to not_enrolled
   * (FR-004, FR-017).
   */
  async withdrawConsent(caller: Caller): Promise<EnrolmentStatusView> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    const existing = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.faceEnrolment.findUnique({ where: { employeeId: employee.id } }),
    );

    if (!existing) {
      // Idempotent: nothing enrolled is the state the caller asked for.
      return {
        status: FaceEnrolmentStatus.not_enrolled,
        enrolledAt: null,
        reEnrolment: null,
      };
    }

    const updated = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        const record = await tx.faceEnrolment.update({
          where: { employeeId: employee.id },
          data: {
            // Nulled, not soft-deleted. FR-004 requires the template to be gone, and
            // a retained-but-flagged descriptor is still biometric data on disk.
            descriptor: null,
            photoRefs: [],
            consentMethod: null,
            consentAcknowledgedAt: null,
            enrolledAt: null,
            status: FaceEnrolmentStatus.not_enrolled,
          },
        });
        // Any pending re-enrolment request is moot once consent is gone (FR-017).
        await tx.reEnrolmentRequest.updateMany({
          where: { employeeId: employee.id, status: 'pending' },
          data: { status: 'expired', decidedAt: new Date() },
        });
        return record;
      },
    );

    // Blobs after the row, not before: if this fails, the database already says the
    // template is gone and a retention sweep will collect the orphans. The reverse
    // order could leave a row pointing at photos that no longer exist, which reads
    // as data corruption rather than as cleanup pending.
    await this.storage.deleteMany(existing.photoRefs);

    await this.auditLog.record({
      entityType: AuditEntityType.FACE_ENROLMENT,
      action: AuditAction.DELETE,
      entityId: existing.id,
      changes: { reason: 'consent_withdrawn' } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    // Null rather than the just-expired request: `reEnrolment` describes what the
    // employee can still act on, and consent withdrawal leaves nothing actionable.
    return { status: updated.status, enrolledAt: null, reEnrolment: null };
  }

  // --------------------------------------------------------------------- US7
  //
  // Re-enrolment is approval-gated rather than self-service (FR-013–FR-016).
  // Replacing a face template is the one operation that can silently redirect an
  // identity: whoever's face goes in next is who the system will accept at the
  // gate from then on. So it takes an approver's decision, a bounded window, and a
  // one-shot unlock, and every step of it is audited.

  /** Asks HR/Admin to reopen enrolment for the caller (FR-013). */
  async requestReEnrolment(
    caller: Caller,
    reason: string,
  ): Promise<ReEnrolmentRequest> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );

    const created = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        const enrolment = await tx.faceEnrolment.findUnique({
          where: { employeeId: employee.id },
        });
        if (
          !enrolment ||
          enrolment.status === FaceEnrolmentStatus.not_enrolled
        ) {
          // Nothing to replace. Enrolling outright is the right path here, and it
          // is already open to them without an approval.
          throw new BadRequestException(
            'You are not enrolled. Complete face enrolment instead of requesting a re-enrolment.',
          );
        }

        const outstanding = await tx.reEnrolmentRequest.findFirst({
          where: {
            employeeId: employee.id,
            status: {
              in: [
                ReEnrolmentRequestStatus.pending,
                ReEnrolmentRequestStatus.approved,
              ],
            },
          },
        });
        if (outstanding) {
          throw new ConflictException(
            outstanding.status === ReEnrolmentRequestStatus.pending
              ? 'You already have a re-enrolment request awaiting a decision.'
              : 'Your re-enrolment has already been approved — complete the fresh capture.',
          );
        }

        const request = await tx.reEnrolmentRequest.create({
          data: {
            employeeId: employee.id,
            reason,
            status: ReEnrolmentRequestStatus.pending,
          },
        });
        await tx.faceEnrolment.update({
          where: { employeeId: employee.id },
          data: { status: FaceEnrolmentStatus.re_enrolment_requested },
        });
        return request;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.RE_ENROLMENT_REQUEST,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: { reason } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    return created;
  }

  /** The approver's queue. RLS confines it to their own company. */
  async listReEnrolmentRequests(
    caller: Caller,
    status: ReEnrolmentRequestStatus = ReEnrolmentRequestStatus.pending,
  ): Promise<ReEnrolmentRequest[]> {
    return withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reEnrolmentRequest.findMany({
        where: { status },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /**
   * Approves or rejects a request (FR-014, FR-015).
   *
   * An approval issues a time-boxed, single-use unlock rather than simply flipping
   * the employee back to "may enrol". An open-ended permission granted once would
   * stay usable indefinitely, which turns one approval into a standing licence to
   * replace the template whenever convenient.
   */
  async decideReEnrolment(
    caller: Caller,
    requestId: string,
    decision: 'approved' | 'rejected',
    remarks?: string,
  ): Promise<ReEnrolmentRequest> {
    const decided = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        const request = await tx.reEnrolmentRequest.findFirst({
          where: { id: requestId },
        });
        if (!request) {
          throw new NotFoundException('Re-enrolment request not found');
        }
        if (request.status !== ReEnrolmentRequestStatus.pending) {
          throw new ConflictException(
            `This request is already ${request.status}.`,
          );
        }

        const now = new Date();
        const updated = await tx.reEnrolmentRequest.update({
          where: { id: requestId },
          data: {
            status:
              decision === 'approved'
                ? ReEnrolmentRequestStatus.approved
                : ReEnrolmentRequestStatus.rejected,
            adminRemarks: remarks ?? null,
            decidedByUserId: caller.userId,
            decidedAt: now,
            unlockExpiresAt:
              decision === 'approved'
                ? new Date(
                    now.getTime() +
                      this.workspace.reEnrolment.unlockDurationDays *
                        86_400_000,
                  )
                : null,
          },
        });

        // A rejection leaves the employee enrolled with their existing template —
        // the request is closed, not their enrolment. Without this the status would
        // stay `re_enrolment_requested` forever, showing a pending request that no
        // longer exists.
        if (decision === 'rejected') {
          await tx.faceEnrolment.updateMany({
            where: {
              employeeId: request.employeeId,
              status: FaceEnrolmentStatus.re_enrolment_requested,
            },
            data: { status: FaceEnrolmentStatus.enrolled },
          });
        }

        return updated;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.RE_ENROLMENT_REQUEST,
      action: AuditAction.UPDATE,
      entityId: decided.id,
      changes: {
        decision,
        remarks: remarks ?? null,
        unlockExpiresAt: decided.unlockExpiresAt?.toISOString() ?? null,
      } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: caller.companyId,
      ipAddress: caller.ipAddress,
    });

    // FR-023 asks for the employee to be notified on both outcomes. As with leave
    // decisions, there is no notification transport in this codebase yet; the
    // decision is recorded and visible on the employee's own enrolment status.
    return decided;
  }

  /** Consumes an approved unlock with a fresh capture (FR-016). */
  async completeReEnrolment(
    caller: Caller,
    photos: string[],
  ): Promise<EnrolmentStatusView> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );
    this.assertPhotoCount(photos);

    const now = new Date();
    const unlock = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.reEnrolmentRequest.findFirst({
        where: {
          employeeId: employee.id,
          status: ReEnrolmentRequestStatus.approved,
          unlockConsumedAt: null,
          unlockExpiresAt: { gt: now },
        },
        orderBy: { decidedAt: 'desc' },
      }),
    );
    if (!unlock) {
      // 403, not 404: the request may well exist — it is the *permission* that is
      // absent, expired, or already spent, and saying so is what tells the
      // employee to ask for a new approval rather than retry.
      throw new ForbiddenException(
        'No active re-enrolment unlock. Request re-enrolment and wait for approval before capturing.',
      );
    }

    const existing = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.faceEnrolment.findUnique({ where: { employeeId: employee.id } }),
    );

    const { descriptor, photoRefs } = await this.buildTemplate(photos);

    const record = await withRlsContext(this.prisma, caller.rls, async (tx) => {
      const updated = await tx.faceEnrolment.update({
        where: { employeeId: employee.id },
        data: {
          descriptor: this.biometrics.serializeDescriptor(descriptor),
          photoRefs,
          enrolledAt: now,
          consentAcknowledgedAt: now,
          status: FaceEnrolmentStatus.enrolled,
        },
      });
      // Consumed inside the same transaction that replaces the template, so a
      // failure part-way cannot leave an unlock that has already been spent still
      // looking available.
      await tx.reEnrolmentRequest.update({
        where: { id: unlock.id },
        data: {
          status: ReEnrolmentRequestStatus.completed,
          unlockConsumedAt: now,
        },
      });
      return updated;
    });

    // "Previous template securely deleted" (FR-016) — the row already points at
    // the new photos, so these are unreferenced biometric data.
    if (existing?.photoRefs?.length) {
      await this.storage.deleteMany(existing.photoRefs);
    }

    await this.auditLog.record({
      entityType: AuditEntityType.RE_ENROLMENT_REQUEST,
      action: AuditAction.UPDATE,
      entityId: unlock.id,
      changes: {
        status: ReEnrolmentRequestStatus.completed,
      } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });
    await this.auditLog.record({
      entityType: AuditEntityType.FACE_ENROLMENT,
      action: AuditAction.UPDATE,
      entityId: record.id,
      changes: {
        reason: 're_enrolment_completed',
        photoCount: photoRefs.length,
      } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    return {
      status: record.status,
      enrolledAt: record.enrolledAt?.toISOString() ?? null,
      // The unlock is spent, so there is nothing left to act on.
      reEnrolment: null,
    };
  }

  /** Enforces the configured photo bounds. The DTO's literals exist for Swagger;
   * these configured values are the ones that actually decide. */
  private assertPhotoCount(photos: string[]): void {
    const { minEnrolmentPhotos, maxEnrolmentPhotos } = this.workspace.faceMatch;
    if (photos.length < minEnrolmentPhotos) {
      throw new BadRequestException(
        `At least ${minEnrolmentPhotos} photos are required to enrol.`,
      );
    }
    if (photos.length > maxEnrolmentPhotos) {
      throw new BadRequestException(
        `At most ${maxEnrolmentPhotos} photos may be submitted.`,
      );
    }
  }

  /** Decode → compress → derive descriptor → store, in that order. Shared by
   * enrolment and re-enrolment so both produce templates the same way. */
  private async buildTemplate(
    photos: string[],
  ): Promise<{ descriptor: Float32Array; photoRefs: string[] }> {
    const decoded = photos.map((photo, index) =>
      decodePhotoPayload(photo, `Photo ${index + 1}`),
    );
    const compressed = await Promise.all(
      decoded.map((photo) => this.images.compressEnrolmentPhoto(photo)),
    );

    let descriptor: Float32Array;
    try {
      descriptor = await this.biometrics.computeDescriptor(compressed);
    } catch (error) {
      if (error instanceof NoFaceDetectedError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const photoRefs = await Promise.all(
      compressed.map((photo) =>
        this.storage.put(ENROLMENT_NAMESPACE, photo, 'image/jpeg'),
      ),
    );
    return { descriptor, photoRefs };
  }
}
