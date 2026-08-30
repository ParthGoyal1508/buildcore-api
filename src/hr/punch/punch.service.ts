import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  ExceptionResolution,
  FaceEnrolmentStatus,
  FaceMatchResult,
  GeofenceResult,
  Prisma,
  PunchRecord,
  PunchType,
} from '@prisma/client';
import { HttpException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import type { WorkspaceConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { CompaniesService } from '../../settings/companies/companies.service';
import { SitesService } from '../../projects/sites/sites.service';
import { BiometricsService } from '../biometrics/biometrics.service';
import { ImageProcessingService } from '../biometrics/image-processing.service';
import { decodePhotoPayload } from '../biometrics/photo-payload';
import type { Caller } from '../biometrics/face-enrolment.service';
import { EmployeesService } from '../employees/employees.service';
import { SubmitPunchDto } from './dto/punch.dto';
import { checkGeofence } from './geofence.util';
import { isPayrollLocked } from './payroll-lock';

const PUNCH_NAMESPACE = 'punch';

/**
 * HTTP 423 Locked — the contract's status for a write into a closed payroll period.
 * Spelled out as a constant because Nest's `HttpStatus` enum has no member for it,
 * and a bare `423` at the throw site reads as a magic number.
 */
const HTTP_STATUS_LOCKED = 423;

export interface PunchResult {
  id: string;
  type: PunchType;
  capturedAt: string;
  isOfflineSync: boolean;
  faceMatchResult: FaceMatchResult;
  geofenceResult: GeofenceResult;
}

/**
 * Punch submission and attendance-exception resolution (US2).
 *
 * The central design rule here is FR-007: a punch that fails verification is still
 * recorded, flagged for an admin, and returned as 201. Only conditions that make a
 * punch *meaningless* — no template to compare against, a broken in/out sequence, a
 * closed payroll period — are rejected. Someone who is physically at work must not
 * end up absent from payroll because of a camera angle or a GPS drift.
 */
@Injectable()
export class PunchService {
  private readonly workspace: WorkspaceConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly employees: EmployeesService,
    private readonly sites: SitesService,
    private readonly companies: CompaniesService,
    private readonly biometrics: BiometricsService,
    private readonly images: ImageProcessingService,
    private readonly storage: StorageService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.workspace = configService.get<WorkspaceConfig>('workspace');
  }

  async submitPunch(caller: Caller, dto: SubmitPunchDto): Promise<PunchResult> {
    const employee = await this.employees.requireByUserId(
      caller.rls,
      caller.userId,
    );

    const capturedAt = new Date(dto.capturedAt);
    const receivedAt = new Date();

    // --- Gate 1: the punch must be attributable to a real template. ---
    const enrolment = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.faceEnrolment.findUnique({ where: { employeeId: employee.id } }),
    );
    if (
      !enrolment ||
      enrolment.status !== FaceEnrolmentStatus.enrolled ||
      !enrolment.descriptor
    ) {
      throw new BadRequestException(
        'No enrolled face template. Complete face enrolment before punching.',
      );
    }

    // --- Gate 2: payroll lock (FR-010) → 423. ---
    //
    // Checked BEFORE the offline-age bound below, though both can apply to one
    // stale punch. Two reasons. "That period is closed" is the more actionable
    // answer — it tells the client the punch will never be accepted, where "too
    // old" reads as though a faster sync would have worked. And ordering it the
    // other way makes this response unreachable in practice: a punch old enough to
    // fall in a locked period is almost always older than the offline window too,
    // so the 423 the contract specifies would never actually be returned.
    const payrollLockDay = await this.companies.getPayrollLockDay(
      employee.companyId,
    );
    if (isPayrollLocked(capturedAt, payrollLockDay, receivedAt)) {
      throw new HttpException(
        'That date falls in a payroll period that is already locked.',
        HTTP_STATUS_LOCKED,
      );
    }

    // --- Gate 3: offline-queue age (FR-012). ---
    const ageHours = (receivedAt.getTime() - capturedAt.getTime()) / 3_600_000;
    if (ageHours > this.workspace.offlineQueue.maxAgeHours) {
      throw new BadRequestException(
        `This punch was captured ${Math.floor(
          ageHours,
        )} hours ago, beyond the ${
          this.workspace.offlineQueue.maxAgeHours
        }-hour offline sync window.`,
      );
    }

    // A punch trailing the server clock by more than the tolerance was queued
    // offline; anything inside the tolerance is ordinary clock drift.
    const isOfflineSync =
      receivedAt.getTime() - capturedAt.getTime() >
      this.workspace.offlineQueue.clockSkewToleranceMinutes * 60_000;

    // --- Verification. Neither check can reject the punch; both can flag it. ---
    const photoBytes = decodePhotoPayload(dto.photo, 'Punch photo');
    const compressed = await this.images.compressPunchPhoto(photoBytes);

    const stored = this.biometrics.deserializeDescriptor(enrolment.descriptor);
    let faceMatchResult: FaceMatchResult = FaceMatchResult.exception;
    let faceMatchDistance: number | null = null;
    const candidate = await this.biometrics
      .computeDescriptor([compressed])
      // A photo with no detectable face is an exception for an admin to look at,
      // not a 400 — the worker is presumably standing there regardless.
      .catch(() => null);
    if (candidate) {
      const match = this.biometrics.compareDescriptors(candidate, stored);
      faceMatchResult = match.matched
        ? FaceMatchResult.matched
        : FaceMatchResult.exception;
      faceMatchDistance = match.distance;
    }

    const geofence = await this.sites.getGeofence(caller.rls, employee.siteId);
    const { withinGeofence, distanceMeters } = checkGeofence(
      { latitude: dto.latitude, longitude: dto.longitude },
      geofence,
    );
    const geofenceResult = withinGeofence
      ? GeofenceResult.in_range
      : GeofenceResult.exception;

    const isException =
      faceMatchResult === FaceMatchResult.exception ||
      geofenceResult === GeofenceResult.exception;

    const photoRef = await this.storage.put(
      PUNCH_NAMESPACE,
      compressed,
      'image/jpeg',
    );

    // --- Gate 4 + write: the in/out sequence, inside one transaction. ---
    const record = await withRlsContext(this.prisma, caller.rls, async (tx) => {
      // `FOR UPDATE` locks the employee's open punch-in row for the rest of this
      // transaction, so two concurrent punch-ins serialise here instead of both
      // reading "no open punch-in" and both inserting (research.md §5). The partial
      // unique index in the migration is the backstop if this is ever bypassed.
      const open = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "hr"."PunchRecord"
        WHERE "employeeId" = ${employee.id}
          AND "type" = 'in'::"hr"."PunchType"
          AND "closedByPunchId" IS NULL
        FOR UPDATE
      `;
      const openPunchIn = open[0] ?? null;

      if (dto.type === PunchType.in && openPunchIn) {
        throw new BadRequestException(
          'You already have an open punch-in. Punch out before punching in again.',
        );
      }
      if (dto.type === PunchType.out && !openPunchIn) {
        throw new BadRequestException(
          'You have no open punch-in to punch out from.',
        );
      }

      const created = await tx.punchRecord.create({
        data: {
          employeeId: employee.id,
          type: dto.type,
          capturedAt,
          receivedAt,
          isOfflineSync,
          photoRef,
          faceMatchResult,
          faceMatchDistance,
          latitude: new Prisma.Decimal(dto.latitude),
          longitude: new Prisma.Decimal(dto.longitude),
          geofenceResult,
          geofenceDistanceMeters: new Prisma.Decimal(distanceMeters.toFixed(2)),
          // Only a flagged punch enters the resolution queue; a clean one has
          // nothing for an admin to decide.
          exceptionResolution: isException ? ExceptionResolution.pending : null,
        },
      });

      // Closing the pair is what releases the partial unique index for the next
      // punch-in, and what makes worked-hours computation a simple pairing later.
      if (dto.type === PunchType.out && openPunchIn) {
        await tx.punchRecord.update({
          where: { id: openPunchIn.id },
          data: { closedByPunchId: created.id },
        });
      }
      return created;
    });

    await this.auditLog.record({
      entityType: AuditEntityType.PUNCH,
      action: AuditAction.CREATE,
      entityId: record.id,
      changes: {
        type: dto.type,
        capturedAt: capturedAt.toISOString(),
        isOfflineSync,
        faceMatchResult,
        geofenceResult,
        geofenceDistanceMeters: Number(distanceMeters.toFixed(2)),
      } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    return this.toResult(record);
  }

  /** The pending exception queue for an admin (FR-011a). RLS confines this to the
   * admin's own company. */
  async listPendingExceptions(caller: Caller): Promise<PunchRecord[]> {
    return withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.punchRecord.findMany({
        where: { exceptionResolution: ExceptionResolution.pending },
        orderBy: { capturedAt: 'desc' },
      }),
    );
  }

  /** Records an admin's verdict on a flagged punch (FR-011a). */
  async resolveException(
    caller: Caller,
    punchId: string,
    resolution: 'confirmed' | 'rejected',
  ): Promise<PunchRecord> {
    const updated = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        const punch = await tx.punchRecord.findFirst({
          where: { id: punchId },
        });
        if (!punch) {
          throw new NotFoundException('Punch record not found');
        }
        if (punch.exceptionResolution !== ExceptionResolution.pending) {
          // Not an error to re-read, but re-deciding a settled exception would
          // silently overwrite another admin's judgement.
          throw new ForbiddenException(
            'This punch has no pending exception to resolve.',
          );
        }
        return tx.punchRecord.update({
          where: { id: punchId },
          data: {
            exceptionResolution:
              resolution === 'confirmed'
                ? ExceptionResolution.confirmed
                : ExceptionResolution.rejected,
            resolvedByUserId: caller.userId,
            resolvedAt: new Date(),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.PUNCH,
      action: AuditAction.UPDATE,
      entityId: updated.id,
      changes: { exceptionResolution: resolution } as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId: caller.companyId,
      ipAddress: caller.ipAddress,
    });

    return updated;
  }

  private toResult(record: PunchRecord): PunchResult {
    return {
      id: record.id,
      type: record.type,
      capturedAt: record.capturedAt.toISOString(),
      isOfflineSync: record.isOfflineSync,
      faceMatchResult: record.faceMatchResult,
      geofenceResult: record.geofenceResult,
    };
  }
}
