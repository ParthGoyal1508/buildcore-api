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
  OVERNIGHT_WINDOW_HOURS,
  openShiftDate,
} from './labour-day.util';
import { labourPunchRefused } from './labour-punch-refusal';

/** 5,000 templates × 512 bytes: every worker of a large company, in ~2.5 MB. */
const TEMPLATE_CACHE_SIZE = 5_000;

export interface LabourDayRow {
  workerId: string;
  labourCode: string;
  fullName: string;
  fatherName: string | null;
  gender: string | null;
  faceEnrolled: boolean;
  punchInAt: string | null;
  punchOutAt: string | null;
  /**
   * 036 O5: an in-punch from yesterday still open and within 16 hours — a night shift the
   * supervisor can punch out today. Null otherwise.
   */
  openShiftFrom: string | null;
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

  /**
   * Registered face templates by storage ref, so a punch does not fetch and decrypt the same blob
   * from object storage every time (044) — that round trip was the slowest step left in a punch.
   *
   * Safe to cache without invalidation because a ref never changes what it points at: retaking a
   * worker's photos stores a new blob under a new ref and deletes the old one, so a stale entry is
   * simply never asked for again. Bounded, oldest out first, so a process that sees every worker
   * in the company still holds at most ~2.5 MB.
   */
  private readonly templates = new Map<string, Float32Array>();

  private async enrolledTemplate(ref: string): Promise<Float32Array> {
    const cached = this.templates.get(ref);
    if (cached) return cached;
    const template = this.biometrics.deserializeDescriptor(
      await this.storage.get(ref),
    );
    if (this.templates.size >= TEMPLATE_CACHE_SIZE) {
      const [oldest] = this.templates.keys();
      this.templates.delete(oldest);
    }
    this.templates.set(ref, template);
    return template;
  }

  /** Every active labour at the site with today's punches, for the supervisor's list. */
  async today(
    caller: AuthenticatedUser,
    siteId: string,
  ): Promise<{ date: string; items: LabourDayRow[] }> {
    await this.supervisorSites.assertSiteAllowed(caller, siteId);
    const date = this.todayInCompanyZone();
    const today = parseDateOnly(date);
    const yesterday = new Date(today.getTime() - 24 * 3_600_000);
    const { workers, punches } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => ({
        workers: await tx.labourWorker.findMany({
          where: { siteId, status: WorkerStatus.active, deletedAt: null },
          orderBy: { labourCode: 'asc' },
        }),
        punches: await tx.labourPunch.findMany({
          where: { siteId, punchDate: { gte: yesterday, lte: today } },
        }),
      }),
    );
    const byWorker = new Map<string, { in?: Date; out?: Date }>();
    const recentByWorker = new Map<string, typeof punches>();
    for (const p of punches) {
      recentByWorker.set(p.workerId, [
        ...(recentByWorker.get(p.workerId) ?? []),
        p,
      ]);
      if (p.punchDate.getTime() !== today.getTime()) continue;
      const entry = byWorker.get(p.workerId) ?? {};
      entry[p.type] = p.punchedAt;
      byWorker.set(p.workerId, entry);
    }
    const now = new Date();
    const rules = await this.refs.getDayRules(
      await this.refs.getSiteCompanyId(caller, siteId),
    );
    return {
      date,
      items: workers.map((w) => {
        const day = byWorker.get(w.id);
        const open = openShiftDate(recentByWorker.get(w.id) ?? [], now, date);
        const openIn =
          open && open !== date
            ? recentByWorker
                .get(w.id)
                ?.find(
                  (p) =>
                    p.type === LabourPunchType.in &&
                    p.punchDate.toISOString().slice(0, 10) === open,
                )
            : undefined;
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
          openShiftFrom: openIn?.punchedAt.toISOString() ?? null,
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
    const today = zonedDateOnly(now, this.refs.timeZone);

    // Order checks before the face work, so a repeated tap is answered at once. A punch-out may
    // close yesterday's punch-in — a night shift (036 O5) — so the day comes from the check.
    const date = await this.assertSequence(
      caller,
      worker.id,
      today,
      dto.type,
      now,
    );
    const punchDate = parseDateOnly(date);

    // The location lookups, the face, the photo's compression and the day rules depend on none of
    // each other, so they run together (044): the punch waits for the slowest rather than their
    // sum. The face is computed from the photo as uploaded, not the compressed copy — the matcher
    // downscales on its own, and waiting for the re-encode only delayed it. The checks below still
    // run in the order they always have; only the waiting overlaps.
    const photo = decodePhotoPayload(dto.photo, 'Labour photo');
    const [geofence, accuracyMax, compressed, stored, candidate, rules] =
      await Promise.all([
        this.refs.getSiteGeofence(caller, dto.siteId),
        this.refs.getPunchAccuracyMaxMetres(worker.companyId),
        this.images.compressPunchPhoto(photo),
        this.enrolledTemplate(worker.faceEnrolmentId),
        this.biometrics.computeDescriptor([photo]).catch(() => null),
        this.refs.getDayRules(worker.companyId),
      ]);

    // --- Location: the employee rule (020 FR-011 to FR-013). ---
    if (!geofence.isActive) {
      throw new BadRequestException(
        'This site is no longer in service, so attendance cannot be marked here.',
      );
    }
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
    let day!: LabourDay;

    try {
      await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
        // One face-punch roll per site and day; the lock stops two supervisors at the same site
        // each creating one on the morning's first punch.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`labour-muster:${dto.siteId}:${date}`}))`;

        // 036 O3: a day already on a payment sheet is closed, whichever way the change comes —
        // a night shift's punch-out lands on yesterday, which a sheet may already cover.
        await this.days.assertNotOnPaymentSheet(tx, {
          companyId: worker.companyId,
          siteId: dto.siteId,
          punchDate,
        });
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

  /**
   * Punch-in once a day; punch-out only after it, and once. Returns the day the punch belongs to:
   * today for a punch-in, and for a punch-out the day of the in-punch it closes — the latest one,
   * if it is still open and at most 16 hours old (036 O5), so a night shift ends on the day it began.
   */
  private async assertSequence(
    caller: AuthenticatedUser,
    workerId: string,
    today: string,
    type: LabourPunchType,
    now: Date,
  ): Promise<string> {
    const todayDate = parseDateOnly(today);
    const yesterday = new Date(todayDate.getTime() - 24 * 3_600_000);
    const punches = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourPunch.findMany({
          where: { workerId, punchDate: { gte: yesterday, lte: todayDate } },
          select: { type: true, punchDate: true, punchedAt: true },
        }),
    );
    const hasToday = (t: LabourPunchType) =>
      punches.some(
        (p) => p.type === t && p.punchDate.getTime() === todayDate.getTime(),
      );
    if (type === LabourPunchType.in) {
      if (hasToday(LabourPunchType.in)) throw this.alreadyPunched(type);
      return today;
    }
    const open = openShiftDate(punches, now, today);
    if (open) return open;
    if (hasToday(LabourPunchType.out)) throw this.alreadyPunched(type);
    throw new ConflictException({
      code: 'LABOUR_NOT_PUNCHED_IN',
      message: `Punch this labour in before punching them out. A punch-out closes a punch-in from the last ${OVERNIGHT_WINDOW_HOURS} hours.`,
    });
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
