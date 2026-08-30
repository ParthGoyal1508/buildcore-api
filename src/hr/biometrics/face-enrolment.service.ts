import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  ConsentMethod,
  FaceEnrolmentStatus,
  Prisma,
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
    const { minEnrolmentPhotos, maxEnrolmentPhotos } = this.workspace.faceMatch;

    // Re-checked against config even though the DTO already bounds the array: the
    // DTO's literals exist for Swagger and cannot read ConfigService, so this is
    // where the configured values are actually enforced.
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

    const decoded = photos.map((photo, index) =>
      decodePhotoPayload(photo, `Photo ${index + 1}`),
    );

    // Compress first, then derive the descriptor from the same bytes that get
    // stored. Computing it from the originals instead would mean the stored photos
    // are not quite what the template was built from — a discrepancy nobody could
    // reproduce later when investigating a match failure.
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
      return { status: FaceEnrolmentStatus.not_enrolled, enrolledAt: null };
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

    return { status: updated.status, enrolledAt: null };
  }
}
