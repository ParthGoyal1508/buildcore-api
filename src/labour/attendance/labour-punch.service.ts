import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  LabourPunchRefusalReason,
  LabourPunchType,
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
import { assertInScope } from '../../settings/company-scope';
import { BiometricsService } from '../../hr/biometrics/biometrics.service';
import { ImageProcessingService } from '../../hr/biometrics/image-processing.service';
import { decodePhotoPayload } from '../../hr/biometrics/photo-payload';
import { zonedDateOnly } from '../../hr/leave/leave-days';
import { checkGeofence } from '../../hr/punch/geofence.util';
import { LABOUR_PUNCH_NAMESPACE } from '../constants/labour.constants';
import { LabourRefsService } from '../labour-refs.service';
import { SupervisorSiteService } from '../supervisor-sites/supervisor-site.service';
import { parseDateOnly } from '../wage-rates/wage-rate.service';
import { LabourDayService } from './labour-day.service';
import {
  deriveLabourDay,
  type LabourDay,
  type LabourDayStatus,
} from './labour-day.util';
import { labourPunchRefused } from './labour-punch-refusal';

export interface LabourDayRow {
  workerId: string;
  labourCode: string;
  fullName: string;
  fatherName: string | null;
  gender: string | null;
  faceEnrolled: boolean;
  punchInAt: string | null;
  punchOutAt: string | null;
  /** 034: how the day counts so far, from the hours between the punches. */
  status: LabourDayStatus;
  hours: number | null;
  overtimeHours: number;
}

export interface LabourPunchResult {
  workerId: string;
  type: LabourPunchType;
  punchedAt: string;
  /** How the day counts after this punch, from the hours between punch in and out (034). */
  status: LabourDayStatus;
  /** Hours between punch in and out, once both are in. */
  hours: number | null;
  overtimeHours: number;
  /** Accepted outside the fence or without a usable fix, because the company has not switched
   * the punch block on — the employee rule. */
  geofenceViolation: boolean;
}

/**
 * Face punch in and out for labour, taken by a site supervisor (031).
 *
 * The labour has no account; the supervisor picks them, photographs them, and the photo is
 * matched against the 3–5 photos taken at registration. A mismatch is **always** refused. Location
 * follows the employee punch rule exactly: the company's accuracy limit and the site fence, refused
 * when the company has switched the punch block on, otherwise accepted and flagged.
 *
 * Accepted punches build the day's muster, which is what payment sheets, reports and project
 * costing already read: one roll per site and day (`source = face_punch`), approved as written —
 * the face match and geofence are the control the old approval step stood in for. Since 034 the
 * line is counted from the hours between punch in and out (`LabourDayService`).
 */
@Injectable()
export class LabourPunchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: LabourRefsService,
    private readonly storage: StorageService,
    private readonly biometrics: BiometricsService,
    private readonly images: ImageProcessingService,
    private readonly supervisorSites: SupervisorSiteService,
    private readonly days: LabourDayService,
  ) {}

  /** Every active labour at the site with today's punches, for the supervisor's list. */
  async today(
    caller: AuthenticatedUser,
    siteId: string,
  ): Promise<{ date: string; items: LabourDayRow[] }> {
    await this.supervisorSites.assertSiteAllowed(caller, siteId);
    const date = this.todayInCompanyZone();
    const { workers, punches } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => ({
        workers: await tx.labourWorker.findMany({
          where: { siteId, status: WorkerStatus.active, deletedAt: null },
          orderBy: { labourCode: 'asc' },
        }),
        punches: await tx.labourPunch.findMany({
          where: { siteId, punchDate: parseDateOnly(date) },
        }),
      }),
    );
    const byWorker = new Map<string, { in?: Date; out?: Date }>();
    for (const p of punches) {
      const entry = byWorker.get(p.workerId) ?? {};
      entry[p.type] = p.punchedAt;
      byWorker.set(p.workerId, entry);
    }
    const rules = await this.refs.getDayRules(
      await this.refs.getSiteCompanyId(caller, siteId),
    );
    return {
      date,
      items: workers.map((w) => {
        const day = byWorker.get(w.id);
        const counted = deriveLabourDay(
          day?.in ?? null,
          day?.out ?? null,
          false,
          rules,
        );
        return {
          workerId: w.id,
          labourCode: w.labourCode,
          fullName: w.fullName,
          fatherName: w.fatherName,
          gender: w.gender,
          faceEnrolled: w.faceEnrolmentId !== null,
          punchInAt: day?.in?.toISOString() ?? null,
          punchOutAt: day?.out?.toISOString() ?? null,
          status: counted.status,
          hours: counted.hours,
          overtimeHours: counted.overtimeHours,
        };
      }),
    };
  }

  /** Refused attempts at a site over the last `days` days, newest first. */
  async refusals(caller: AuthenticatedUser, siteId: string, days = 7) {
    await this.supervisorSites.assertSiteAllowed(caller, siteId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourPunchRefusal.findMany({
          where: { siteId, createdAt: { gte: since } },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
    );
    const workers = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourWorker.findMany({
          where: {
            id: { in: Array.from(new Set(rows.map((r) => r.workerId))) },
          },
          select: { id: true, labourCode: true, fullName: true },
        }),
    );
    const byId = new Map(workers.map((w) => [w.id, w]));
    return rows.map((r) => ({
      id: r.id,
      workerId: r.workerId,
      labourCode: byId.get(r.workerId)?.labourCode ?? null,
      fullName: byId.get(r.workerId)?.fullName ?? null,
      type: r.type,
      reason: r.reason,
      at: r.createdAt.toISOString(),
    }));
  }

  async punch(
    caller: AuthenticatedUser,
    dto: {
      siteId: string;
      workerId: string;
      type: LabourPunchType;
      photo: string;
      latitude: number;
      longitude: number;
      accuracyMeters?: number;
    },
    ipAddress: string,
  ): Promise<LabourPunchResult> {
    await this.supervisorSites.assertSiteAllowed(caller, dto.siteId);

    const worker = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.labourWorker.findUnique({ where: { id: dto.workerId } }),
    );
    if (!worker || worker.deletedAt) {
      throw new NotFoundException('Labour not found');
    }
    assertInScope(caller, worker, 'Labour');
    if (worker.status !== WorkerStatus.active || worker.siteId !== dto.siteId) {
      throw new BadRequestException(
        `${worker.fullName} is not active at this site.`,
      );
    }
    if (!worker.faceEnrolmentId) {
      throw new BadRequestException({
        code: 'LABOUR_FACE_NOT_ENROLLED',
        message: `${worker.fullName} has no registered face photos yet. Take their 3 to 5 photos first.`,
      });
    }

    // The punch is online-only and the server's clock is the one that counts, so a phone set to
    // yesterday cannot mark yesterday.
    const now = new Date();
    const date = zonedDateOnly(now, this.refs.timeZone);
    const punchDate = parseDateOnly(date);

    // Order checks before the face work, so a repeated tap is answered at once.
    await this.assertSequence(caller, worker.id, punchDate, dto.type);

    // --- Location: the employee rule (020 FR-011 to FR-013). ---
    const geofence = await this.refs.getSiteGeofence(caller, dto.siteId);
    if (!geofence.isActive) {
      throw new BadRequestException(
        'This site is no longer in service, so attendance cannot be marked here.',
      );
    }
    const accuracyMax = await this.refs.getPunchAccuracyMaxMetres(
      worker.companyId,
    );
    const unlocatable =
      dto.accuracyMeters !== undefined && dto.accuracyMeters > accuracyMax;
    const { withinGeofence, distanceMeters } = checkGeofence(
      {
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracyMeters: unlocatable ? undefined : dto.accuracyMeters,
      },
      geofence,
    );
    const locationReason = unlocatable
      ? LabourPunchRefusalReason.unlocatable
      : !withinGeofence
      ? LabourPunchRefusalReason.outside_geofence
      : null;

    // --- Face: always refuses on failure (031). ---
    const compressed = await this.images.compressPunchPhoto(
      decodePhotoPayload(dto.photo, 'Labour photo'),
    );
    const stored = this.biometrics.deserializeDescriptor(
      await this.storage.get(worker.faceEnrolmentId),
    );
    const candidate = await this.biometrics
      .computeDescriptor([compressed])
      .catch(() => null);
    const match = candidate
      ? this.biometrics.compareDescriptors(candidate, stored)
      : null;
    const faceReason = !candidate
      ? LabourPunchRefusalReason.no_face_detected
      : !match?.matched
      ? LabourPunchRefusalReason.face_mismatch
      : null;

    // Location first when both fail and the block is on — the one the supervisor can act on
    // from where they stand (refusal.md CHK032).
    const enforced = locationReason
      ? await this.refs.isPunchBlockEnforced(worker.companyId)
      : false;
    const refusal = enforced && locationReason ? locationReason : faceReason;
    if (refusal) {
      await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
        tx.labourPunchRefusal.create({
          data: {
            companyId: worker.companyId,
            workerId: worker.id,
            siteId: dto.siteId,
            type: dto.type,
            reason: refusal,
            supervisorId: caller.id,
            latitude: dto.latitude,
            longitude: dto.longitude,
            accuracyMetres: dto.accuracyMeters ?? null,
            distanceMetres: distanceMeters,
            faceMatchDistance: match?.distance ?? null,
          },
        }),
      );
      throw labourPunchRefused(refusal);
    }

    // Stored only once accepted: a refused photo would be an orphan nothing references.
    const photoRef = await this.storage.put(
      LABOUR_PUNCH_NAMESPACE,
      compressed,
      'image/jpeg',
    );
    const geofenceViolation = locationReason !== null;
    const rules = await this.refs.getDayRules(worker.companyId);
    let day!: LabourDay;

    try {
      await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
        // One face-punch roll per site and day; the lock stops two supervisors at the same site
        // each creating one on the morning's first punch.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`labour-muster:${dto.siteId}:${date}`}))`;

        await this.assertNoLegacyMuster(tx, worker.id, punchDate);

        await tx.labourPunch.create({
          data: {
            companyId: worker.companyId,
            workerId: worker.id,
            siteId: dto.siteId,
            punchDate,
            type: dto.type,
            punchedAt: now,
            supervisorId: caller.id,
            photoRef,
            faceMatchDistance: match?.distance ?? 0,
            latitude: dto.latitude,
            longitude: dto.longitude,
            accuracyMetres: dto.accuracyMeters ?? null,
            geofenceDistanceMetres: distanceMeters,
            geofenceViolation,
          },
        });

        day = await this.days.syncDay(tx, {
          companyId: worker.companyId,
          workerId: worker.id,
          siteId: dto.siteId,
          punchDate,
          rules,
          actorId: caller.id,
          latitude: dto.latitude,
          longitude: dto.longitude,
          accuracyMetres: dto.accuracyMeters ?? 0,
          geofenceViolation,
          skillCategoryIdOnDay: worker.skillCategoryId,
        });
      });
    } catch (err) {
      // Nothing references the photo once the write is rolled back.
      await this.storage.delete(photoRef).catch(() => undefined);
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Two taps racing past `assertSequence`; the unique index decided.
        throw this.alreadyPunched(dto.type, worker.fullName);
      }
      throw err;
    }

    await this.auditLog.record({
      entityType: AuditEntityType.MUSTER_ROLL,
      action: AuditAction.CREATE,
      entityId: worker.id,
      accountId: caller.id,
      companyId: worker.companyId,
      ipAddress,
      changes: {
        labourPunch: dto.type,
        siteId: dto.siteId,
        date,
        geofenceViolation,
      },
    });

    return {
      workerId: worker.id,
      type: dto.type,
      punchedAt: now.toISOString(),
      status: day.status,
      hours: day.hours,
      overtimeHours: day.overtimeHours,
      geofenceViolation,
    };
  }

  /** Punch-in once a day; punch-out only after it, and once. */
  private async assertSequence(
    caller: AuthenticatedUser,
    workerId: string,
    punchDate: Date,
    type: LabourPunchType,
  ): Promise<void> {
    const punches = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourPunch.findMany({
          where: { workerId, punchDate },
          select: { type: true },
        }),
    );
    const has = (t: LabourPunchType) => punches.some((p) => p.type === t);
    if (has(type)) {
      throw this.alreadyPunched(type);
    }
    if (type === LabourPunchType.out && !has(LabourPunchType.in)) {
      throw new ConflictException({
        code: 'LABOUR_NOT_PUNCHED_IN',
        message: 'Punch this labour in before punching them out.',
      });
    }
  }

  private alreadyPunched(type: LabourPunchType, name?: string) {
    const who = name ?? 'This labour';
    return new ConflictException({
      code: 'LABOUR_ALREADY_PUNCHED',
      message:
        type === LabourPunchType.in
          ? `${who} is already punched in today.`
          : `${who} is already punched out today.`,
    });
  }

  /**
   * A worker already on a muster captured the old way for the same day would be paid twice once
   * the punch adds a line of its own, so the punch is refused and the clash named.
   */
  private async assertNoLegacyMuster(
    tx: Prisma.TransactionClient,
    workerId: string,
    punchDate: Date,
  ): Promise<void> {
    const clash = await tx.musterLine.findFirst({
      where: {
        workerId,
        muster: {
          date: punchDate,
          deletedAt: null,
          source: { not: MusterSource.face_punch },
          status: { in: [MusterStatus.submitted, MusterStatus.approved] },
        },
      },
    });
    if (clash) {
      throw new ConflictException({
        code: 'LABOUR_ALREADY_ON_MUSTER',
        message:
          'This labour is already on a muster for today that was entered another way.',
      });
    }
  }

  private todayInCompanyZone(): string {
    return zonedDateOnly(new Date(), this.refs.timeZone);
  }
}
