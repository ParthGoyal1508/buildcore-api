import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceType,
  AuditAction,
  AuditEntityType,
  MusterSource,
  MusterStatus,
  Prisma,
  WorkerStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { BiometricsService } from '../../hr/biometrics/biometrics.service';
import { ImageProcessingService } from '../../hr/biometrics/image-processing.service';
import { decodePhotoPayload } from '../../hr/biometrics/photo-payload';
import { checkGeofence } from '../../hr/punch/geofence.util';
import { MUSTER_PHOTO_NAMESPACE } from '../constants/labour.constants';
import { LabourRefsService } from '../labour-refs.service';
import { GangService } from '../workers/gang.service';
import { parseDateOnly } from '../wage-rates/wage-rate.service';
import { WageRateService } from '../wage-rates/wage-rate.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface MusterLineInput {
  workerId: string;
  attendanceType: AttendanceType;
  overtimeHours?: number;
  photo?: string;
}

@Injectable()
export class MusterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: LabourRefsService,
    private readonly storage: StorageService,
    private readonly biometrics: BiometricsService,
    private readonly images: ImageProcessingService,
    private readonly gangs: GangService,
    private readonly wageRates: WageRateService,
  ) {}

  /** Opens a draft muster session, validating GPS against the site geofence and
   * flagging (never rejecting) a violation or low accuracy (FR-013). A date outside
   * the backdating window is rejected (FR-019). */
  async open(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      siteId: string;
      date: string;
      latitude: number;
      longitude: number;
      accuracyMetres: number;
      capturedAt?: string;
    },
    ipAddress: string,
  ) {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      throw new NotFoundException('Company not found');
    }
    const date = parseDateOnly(dto.date);
    this.assertWithinBackdatingWindow(date);

    const geofence = await this.refs.getSiteGeofence(caller, dto.siteId);
    const { withinGeofence, distanceMeters } = checkGeofence(
      { latitude: dto.latitude, longitude: dto.longitude },
      {
        latitude: geofence.latitude,
        longitude: geofence.longitude,
        geofenceRadiusMeters: geofence.geofenceRadiusMeters,
      },
    );
    const geofenceViolation = !withinGeofence;
    const lowGpsAccuracy = dto.accuracyMetres > this.refs.gpsAccuracyMaxMetres;

    const { capturedAt, isOfflineSynced } = this.resolveCapturedAt(
      dto.capturedAt,
    );

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.musterRoll.create({
          data: {
            companyId,
            siteId: dto.siteId,
            date,
            supervisorId: caller.id,
            latitude: dto.latitude,
            longitude: dto.longitude,
            accuracyMetres: dto.accuracyMetres,
            geofenceViolation,
            lowGpsAccuracy,
            distanceFromFenceMetres: geofenceViolation
              ? Math.max(0, distanceMeters - geofence.geofenceRadiusMeters)
              : null,
            source: MusterSource.mobile,
            capturedAt,
            isOfflineSynced,
            status: MusterStatus.draft,
            createdBy: caller.id,
          },
        }),
    );

    await this.audit(
      AuditAction.CREATE,
      created.id,
      companyId,
      caller,
      ipAddress,
    );
    return this.findOne(caller, created.id);
  }

  /** Adds or updates a worker's line on a draft muster, storing the photo encrypted
   * and computing an advisory face match (FR-014). */
  async addLine(
    caller: AuthenticatedUser,
    musterId: string,
    line: MusterLineInput,
    ipAddress: string,
  ) {
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const muster = await this.loadDraft(tx, caller, musterId);
      await this.upsertLine(tx, caller, muster, line);
    });
    await this.audit(
      AuditAction.UPDATE,
      musterId,
      caller.companyId ?? null,
      caller,
      ipAddress,
    );
    return this.findOne(caller, musterId);
  }

  /** Expands a gang into a line per active member (FR-027/AC8), each still needing
   * its own photo before submission. */
  async bulkAddGang(
    caller: AuthenticatedUser,
    musterId: string,
    dto: { gangId: string; attendanceType: AttendanceType },
    ipAddress: string,
  ) {
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const muster = await this.loadDraft(tx, caller, musterId);
      const memberIds = await this.gangs.activeMemberIds(tx, dto.gangId);
      for (const workerId of memberIds) {
        const existing = await tx.musterLine.findUnique({
          where: { musterId_workerId: { musterId, workerId } },
        });
        if (existing) continue;
        await this.upsertLine(tx, caller, muster, {
          workerId,
          attendanceType: dto.attendanceType,
        });
      }
    });
    await this.audit(
      AuditAction.UPDATE,
      musterId,
      caller.companyId ?? null,
      caller,
      ipAddress,
    );
    return this.findOne(caller, musterId);
  }

  /** Submits a draft muster: every line must have a photo (FR-010), and there may be
   * only one submitted/approved muster per site per date (FR-016). The uniqueness is
   * checked under a row lock, with the partial unique index as the backstop. */
  async submit(caller: AuthenticatedUser, musterId: string, ipAddress: string) {
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const muster = await this.loadDraft(tx, caller, musterId);
      const lines = await tx.musterLine.findMany({
        where: { musterId },
      });
      if (lines.length === 0) {
        throw new BadRequestException('A muster must have at least one line');
      }
      const missingPhoto = lines.some((l) => !l.photoRef);
      if (missingPhoto) {
        throw new BadRequestException(
          'Every marked worker must have a captured photo before submission',
        );
      }

      await this.assertNoExistingMuster(
        tx,
        muster.siteId,
        muster.date,
        musterId,
      );

      await tx.musterRoll.update({
        where: { id: musterId },
        data: { status: MusterStatus.submitted },
      });
    });
    await this.audit(
      AuditAction.UPDATE,
      musterId,
      caller.companyId ?? null,
      caller,
      ipAddress,
    );
    return this.findOne(caller, musterId);
  }

  /**
   * Composite offline-drain path: opens, marks, and submits a whole muster in one
   * transaction (FR-018). This is what the frontend replays when a queued offline
   * muster drains — a single atomic capture rather than a sequence of round trips
   * that could half-apply.
   */
  async capture(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      siteId: string;
      date: string;
      latitude: number;
      longitude: number;
      accuracyMetres: number;
      capturedAt?: string;
      lines: MusterLineInput[];
    },
    ipAddress: string,
  ) {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      throw new NotFoundException('Company not found');
    }
    if (dto.lines.length === 0) {
      throw new BadRequestException('A muster must have at least one line');
    }
    const date = parseDateOnly(dto.date);
    this.assertWithinBackdatingWindow(date);

    const geofence = await this.refs.getSiteGeofence(caller, dto.siteId);
    const { withinGeofence, distanceMeters } = checkGeofence(
      { latitude: dto.latitude, longitude: dto.longitude },
      {
        latitude: geofence.latitude,
        longitude: geofence.longitude,
        geofenceRadiusMeters: geofence.geofenceRadiusMeters,
      },
    );
    const geofenceViolation = !withinGeofence;
    const lowGpsAccuracy = dto.accuracyMetres > this.refs.gpsAccuracyMaxMetres;
    const { capturedAt, isOfflineSynced } = this.resolveCapturedAt(
      dto.capturedAt,
    );

    const musterId = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        await this.assertNoExistingMuster(tx, dto.siteId, date, null);

        const muster = await tx.musterRoll.create({
          data: {
            companyId,
            siteId: dto.siteId,
            date,
            supervisorId: caller.id,
            latitude: dto.latitude,
            longitude: dto.longitude,
            accuracyMetres: dto.accuracyMetres,
            geofenceViolation,
            lowGpsAccuracy,
            distanceFromFenceMetres: geofenceViolation
              ? Math.max(0, distanceMeters - geofence.geofenceRadiusMeters)
              : null,
            source: MusterSource.mobile,
            capturedAt,
            isOfflineSynced,
            status: MusterStatus.draft,
            createdBy: caller.id,
          },
        });

        for (const line of dto.lines) {
          if (!line.photo) {
            throw new BadRequestException(
              'Every marked worker must have a captured photo',
            );
          }
          await this.upsertLine(tx, caller, muster, line);
        }

        await tx.musterRoll.update({
          where: { id: muster.id },
          data: { status: MusterStatus.submitted },
        });
        return muster.id;
      },
    );

    await this.audit(
      AuditAction.CREATE,
      musterId,
      companyId,
      caller,
      ipAddress,
    );
    return this.findOne(caller, musterId);
  }

  // ── Approval (US4) ──────────────────────────────────────────────────────────

  async findAll(
    caller: AuthenticatedUser,
    query: {
      companyId?: string;
      status?: MusterStatus;
      siteId?: string;
      flagged?: boolean;
    },
  ) {
    const where: Prisma.MusterRollWhereInput = {
      ...companyScope(caller, query.companyId),
      deletedAt: null,
      status: query.status ?? MusterStatus.submitted,
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.flagged
        ? { OR: [{ geofenceViolation: true }, { lowGpsAccuracy: true }] }
        : {}),
    };

    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.musterRoll.findMany({
          where,
          orderBy: { date: 'asc' },
          include: {
            _count: { select: { lines: true } },
            lines: { select: { faceMatchLow: true } },
          },
        }),
    );

    return rows.map((row) => ({
      id: row.id,
      siteId: row.siteId,
      date: row.date.toISOString().slice(0, 10),
      supervisorId: row.supervisorId,
      status: row.status,
      lineCount: row._count.lines,
      geofenceViolation: row.geofenceViolation,
      lowGpsAccuracy: row.lowGpsAccuracy,
      faceMatchLowCount: row.lines.filter((l) => l.faceMatchLow).length,
    }));
  }

  async findOne(caller: AuthenticatedUser, id: string) {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.musterRoll.findUnique({
        where: { id },
        include: { lines: true },
      }),
    );
    if (!row || row.deletedAt) {
      throw new NotFoundException(`Muster ${id} not found`);
    }
    assertInScope(caller, row, `Muster ${id}`);

    const projectId = await this.refs
      .getSiteProjectId(caller, row.siteId)
      .catch(() => null);

    const lines = await Promise.all(
      row.lines.map(async (line) => {
        let applicableRate: number | null = null;
        if (projectId) {
          const worker = await withRlsContext(
            this.prisma,
            rlsContextFor(caller),
            (tx) =>
              tx.labourWorker.findUnique({
                where: { id: line.workerId },
                select: { rateOverride: true },
              }),
          );
          const resolved = await this.wageRates.resolveRate(caller, {
            projectId,
            skillCategoryId: line.skillCategoryIdOnDay,
            rateOverride: worker?.rateOverride
              ? worker.rateOverride.toNumber()
              : null,
            date: row.date,
          });
          applicableRate = resolved?.rate ?? null;
        }
        return {
          id: line.id,
          workerId: line.workerId,
          attendanceType: line.attendanceType,
          overtimeHours: line.overtimeHours
            ? line.overtimeHours.toNumber()
            : null,
          photoRef: line.photoRef,
          faceMatchScore: line.faceMatchScore
            ? line.faceMatchScore.toNumber()
            : null,
          faceMatchLow: line.faceMatchLow,
          skillCategoryIdOnDay: line.skillCategoryIdOnDay,
          applicableRate,
        };
      }),
    );

    return {
      id: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      projectId,
      date: row.date.toISOString().slice(0, 10),
      supervisorId: row.supervisorId,
      latitude: row.latitude.toNumber(),
      longitude: row.longitude.toNumber(),
      accuracyMetres: row.accuracyMetres.toNumber(),
      geofenceViolation: row.geofenceViolation,
      lowGpsAccuracy: row.lowGpsAccuracy,
      distanceFromFenceMetres: row.distanceFromFenceMetres
        ? row.distanceFromFenceMetres.toNumber()
        : null,
      isOfflineSynced: row.isOfflineSynced,
      capturedAt: row.capturedAt.toISOString(),
      status: row.status,
      approvedBy: row.approvedBy,
      returnReason: row.returnReason,
      lines,
    };
  }

  async approve(caller: AuthenticatedUser, id: string, ipAddress: string) {
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const muster = await tx.musterRoll.findUnique({ where: { id } });
      if (!muster || muster.deletedAt) {
        throw new NotFoundException(`Muster ${id} not found`);
      }
      assertInScope(caller, muster, `Muster ${id}`);
      if (muster.status !== MusterStatus.submitted) {
        throw new ConflictException('Only a submitted muster can be approved');
      }
      await tx.musterRoll.update({
        where: { id },
        data: {
          status: MusterStatus.approved,
          approvedBy: caller.id,
          approvedAt: new Date(),
        },
      });
    });
    await this.audit(
      AuditAction.UPDATE,
      id,
      caller.companyId ?? null,
      caller,
      ipAddress,
    );
    return this.findOne(caller, id);
  }

  async returnToDraft(
    caller: AuthenticatedUser,
    id: string,
    reason: string,
    ipAddress: string,
  ) {
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const muster = await tx.musterRoll.findUnique({ where: { id } });
      if (!muster || muster.deletedAt) {
        throw new NotFoundException(`Muster ${id} not found`);
      }
      assertInScope(caller, muster, `Muster ${id}`);
      if (muster.status !== MusterStatus.submitted) {
        throw new ConflictException('Only a submitted muster can be returned');
      }
      await tx.musterRoll.update({
        where: { id },
        data: { status: MusterStatus.draft, returnReason: reason },
      });
    });
    await this.audit(
      AuditAction.UPDATE,
      id,
      caller.companyId ?? null,
      caller,
      ipAddress,
    );
    return this.findOne(caller, id);
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async loadDraft(
    tx: Prisma.TransactionClient,
    caller: AuthenticatedUser,
    musterId: string,
  ) {
    const muster = await tx.musterRoll.findUnique({ where: { id: musterId } });
    if (!muster || muster.deletedAt) {
      throw new NotFoundException(`Muster ${musterId} not found`);
    }
    assertInScope(caller, muster, `Muster ${musterId}`);
    if (muster.status !== MusterStatus.draft) {
      throw new ConflictException(
        'This muster is no longer editable — it has been submitted or approved',
      );
    }
    return muster;
  }

  private async upsertLine(
    tx: Prisma.TransactionClient,
    caller: AuthenticatedUser,
    muster: { id: string; companyId: string; siteId: string; date: Date },
    line: MusterLineInput,
  ) {
    if (
      line.attendanceType === AttendanceType.overtime_only &&
      (line.overtimeHours === undefined || line.overtimeHours <= 0)
    ) {
      throw new BadRequestException(
        'Overtime-only attendance requires overtime hours',
      );
    }

    const worker = await tx.labourWorker.findUnique({
      where: { id: line.workerId },
    });
    if (!worker || worker.deletedAt) {
      throw new BadRequestException(`Worker ${line.workerId} not found`);
    }
    if (
      worker.status !== WorkerStatus.active ||
      worker.siteId !== muster.siteId
    ) {
      throw new BadRequestException(
        'Worker is not active at this site on this date',
      );
    }

    const otherSite = await tx.musterLine.findFirst({
      where: {
        workerId: line.workerId,
        muster: {
          date: muster.date,
          siteId: { not: muster.siteId },
          status: { in: [MusterStatus.submitted, MusterStatus.approved] },
        },
      },
      include: { muster: { select: { siteId: true } } },
    });
    if (otherSite) {
      throw new ConflictException({
        message: 'Worker is already marked at another site on this date',
        workerId: line.workerId,
        otherSiteId: otherSite.muster.siteId,
      });
    }

    let photoRef: string | undefined;
    let faceMatchScore: number | null = null;
    let faceMatchLow = false;
    if (line.photo) {
      const bytes = decodePhotoPayload(line.photo, 'Muster photo');
      const compressed = await this.images.compressPunchPhoto(bytes);
      photoRef = await this.storage.put(
        MUSTER_PHOTO_NAMESPACE,
        compressed,
        'image/jpeg',
      );
      const match = await this.faceMatch(worker.faceEnrolmentId, compressed);
      faceMatchScore = match.score;
      faceMatchLow = match.low;
    }

    await tx.musterLine.upsert({
      where: {
        musterId_workerId: { musterId: muster.id, workerId: line.workerId },
      },
      create: {
        companyId: muster.companyId,
        musterId: muster.id,
        workerId: line.workerId,
        attendanceType: line.attendanceType,
        overtimeHours: line.overtimeHours ?? null,
        photoRef: photoRef ?? null,
        faceMatchScore,
        faceMatchLow,
        skillCategoryIdOnDay: worker.skillCategoryId,
      },
      update: {
        attendanceType: line.attendanceType,
        overtimeHours: line.overtimeHours ?? null,
        ...(photoRef ? { photoRef, faceMatchScore, faceMatchLow } : {}),
      },
    });
  }

  /** Advisory face match against the worker's enrolled descriptor (FR-014). A
   * below-threshold match is flagged, never blocked; no enrolment means no basis, so
   * it is neither scored nor flagged. */
  private async faceMatch(
    faceEnrolmentId: string | null,
    photo: Buffer,
  ): Promise<{ score: number | null; low: boolean }> {
    if (!faceEnrolmentId) return { score: null, low: false };
    try {
      const stored = this.biometrics.deserializeDescriptor(
        await this.storage.get(faceEnrolmentId),
      );
      const candidate = await this.biometrics.computeDescriptor([photo]);
      const match = this.biometrics.compareDescriptors(candidate, stored);
      return { score: match.distance, low: !match.matched };
    } catch {
      // A photo with no detectable face, or a missing descriptor, is not a reason
      // to reject the line — face match is advisory for labour.
      return { score: null, low: false };
    }
  }

  private async assertNoExistingMuster(
    tx: Prisma.TransactionClient,
    siteId: string,
    date: Date,
    excludeId: string | null,
  ) {
    const existing = await tx.musterRoll.findFirst({
      where: {
        siteId,
        date,
        status: { in: [MusterStatus.submitted, MusterStatus.approved] },
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    if (existing) {
      throw new ConflictException({
        message: 'A muster already exists for this site and date',
        existingMusterId: existing.id,
      });
    }
  }

  private assertWithinBackdatingWindow(date: Date): void {
    const now = Date.now();
    const ageMs = now - date.getTime();
    const maxMs = this.refs.backdatingMaxAgeHours * 60 * 60 * 1000;
    if (ageMs > maxMs) {
      throw new BadRequestException(
        'This date is outside the allowed backdating window',
      );
    }
    if (date.getTime() - now > MS_PER_DAY) {
      throw new BadRequestException('A muster cannot be dated in the future');
    }
  }

  private resolveCapturedAt(capturedAt?: string): {
    capturedAt: Date;
    isOfflineSynced: boolean;
  } {
    if (!capturedAt) {
      return { capturedAt: new Date(), isOfflineSynced: false };
    }
    const captured = new Date(capturedAt);
    if (Number.isNaN(captured.getTime())) {
      throw new BadRequestException('Invalid capturedAt timestamp');
    }
    const skewMs = this.refs.clockSkewToleranceMinutes * 60 * 1000;
    const isOfflineSynced = Date.now() - captured.getTime() > skewMs;
    return { capturedAt: captured, isOfflineSynced };
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string | null,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.MUSTER_ROLL,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
