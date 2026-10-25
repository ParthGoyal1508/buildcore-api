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
  LabourPunchSource,
  LabourPunchType,
  MusterSource,
  MusterStatus,
  WorkerStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { ImageProcessingService } from '../../hr/biometrics/image-processing.service';
import { decodePhotoPayload } from '../../hr/biometrics/photo-payload';
import { zonedDateOnly, zonedDayBounds } from '../../hr/leave/leave-days';
import { assertInScope, resolveCompanyId } from '../../settings/company-scope';
import { LABOUR_SITE_PHOTO_NAMESPACE } from '../constants/labour.constants';
import { LabourRefsService } from '../labour-refs.service';
import {
  SupervisorSiteService,
  type SiteOption,
} from '../supervisor-sites/supervisor-site.service';
import { parseDateOnly } from '../wage-rates/wage-rate.service';
import { LabourDayService } from './labour-day.service';
import {
  deriveLabourDay,
  type LabourDayFlag,
  type LabourDayRules,
  type LabourDayStatus,
  labourDayRulesProblem,
  OVERNIGHT_WINDOW_HOURS,
} from './labour-day.util';

export interface PunchFact {
  at: string;
  source: LabourPunchSource;
  corrected: boolean;
  recordedBy: string | null;
  /** Accepted outside the site fence (the company does not refuse those). */
  outsideFence: boolean;
}

/** One worker's day at one site. */
export interface MusterDay {
  date: string;
  punchIn: PunchFact | null;
  punchOut: PunchFact | null;
  hours: number | null;
  status: LabourDayStatus;
  overtimeHours: number;
  flag: LabourDayFlag | null;
  /** Marked on a muster entered before face punches (pre-031), so it has no times. */
  manual: boolean;
}

export interface MusterWorkerRef {
  workerId: string;
  labourCode: string;
  fullName: string;
  fatherName: string | null;
  gender: string | null;
  contractorName: string | null;
  gangName: string | null;
  siteId: string;
  siteName: string;
}

export interface MusterDailyRow extends MusterWorkerRef, MusterDay {}

export interface MusterSummary {
  workers: number;
  present: number;
  fullDay: number;
  halfDay: number;
  short: number;
  onSite: number;
  absent: number;
  missingPunchOut: number;
  otherFlags: number;
  overtimeHours: number;
}

export interface MusterMonthTotals {
  fullDays: number;
  halfDays: number;
  shortDays: number;
  unresolved: number;
  /** Full days plus half days at a half, the figure a payment sheet pays. */
  payableDays: number;
  hours: number;
  overtimeHours: number;
}

export interface MusterMonthRow extends MusterWorkerRef {
  days: Record<string, MusterDay>;
  totals: MusterMonthTotals;
}

export type MusterFilter =
  | 'missing_punch_out'
  | 'flagged'
  | 'present'
  | 'absent'
  | 'on_site'
  | 'short';

/**
 * Muster attendance read from punch times (034): the daily and monthly views, corrections with an
 * edit history, the company's day rules, and the supervisor's reference group photos.
 *
 * Every view and the Excel export derive the day with `deriveLabourDay` from the punches and the
 * company's current rules, so the screen, the sheet and the muster line a payment sheet prices agree.
 */
@Injectable()
export class MusterAttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: LabourRefsService,
    private readonly storage: StorageService,
    private readonly images: ImageProcessingService,
    private readonly supervisorSites: SupervisorSiteService,
    private readonly days: LabourDayService,
  ) {}

  // ── Views ───────────────────────────────────────────────────────────────────

  async daily(
    caller: AuthenticatedUser,
    query: {
      date?: string;
      siteId?: string;
      filter?: MusterFilter;
      search?: string;
    },
  ): Promise<{
    date: string;
    today: string;
    summary: MusterSummary;
    items: MusterDailyRow[];
  }> {
    const today = this.days.today();
    const date = query.date ?? today;
    if (date > today) {
      throw new BadRequestException('That date has not happened yet.');
    }
    const sites = await this.chosenSites(caller, query.siteId);
    const grid = await this.collect(caller, sites, date, date);
    const rows: MusterDailyRow[] = grid.map(({ ref, days }) => ({
      ...ref,
      ...(days.get(date) ?? emptyDay(date)),
    }));
    // The summary describes the whole day; `filter` and `search` narrow only the rows shown,
    // so the headline counts cannot change under someone typing in the search box (042).
    const summary = summarise(rows);
    const filter = query.filter;
    const needle = query.search?.trim().toLowerCase();
    const items = rows.filter(
      (r) =>
        (!filter || matches(r, filter)) &&
        (!needle ||
          r.fullName.toLowerCase().includes(needle) ||
          r.labourCode.toLowerCase().includes(needle)),
    );
    return { date, today, summary, items };
  }

  async monthly(
    caller: AuthenticatedUser,
    query: { year: number; month: number; siteId?: string },
  ): Promise<{
    year: number;
    month: number;
    daysInMonth: number;
    today: string;
    summary: {
      workers: number;
      unresolved: number;
      payableDays: number;
      overtimeHours: number;
    };
    items: MusterMonthRow[];
  }> {
    const { from, to, daysInMonth } = monthRange(query.year, query.month);
    const today = this.days.today();
    const sites = await this.chosenSites(caller, query.siteId);
    const grid = await this.collect(
      caller,
      sites,
      from,
      to < today ? to : today,
    );
    const items = grid.map(({ ref, days }) => {
      const record: Record<string, MusterDay> = {};
      for (const [date, day] of days) {
        if (day.status !== 'absent' || day.manual) record[date] = day;
      }
      return {
        ...ref,
        days: record,
        totals: monthTotals(Object.values(record)),
      };
    });
    return {
      year: query.year,
      month: query.month,
      daysInMonth,
      today,
      summary: {
        workers: items.length,
        unresolved: sum(items.map((i) => i.totals.unresolved)),
        payableDays: round2(sum(items.map((i) => i.totals.payableDays))),
        overtimeHours: round2(sum(items.map((i) => i.totals.overtimeHours))),
      },
      items,
    };
  }

  /**
   * Every worker at the sites — active ones, and anyone who punched or was on a muster there in the
   * range — with each day between `from` and `to` derived. Shared by the views and the export.
   */
  async collect(
    caller: AuthenticatedUser,
    sites: SiteOption[],
    from: string,
    to: string,
  ): Promise<{ ref: MusterWorkerRef; days: Map<string, MusterDay> }[]> {
    const siteIds = sites.map((s) => s.id);
    const siteName = new Map(sites.map((s) => [s.id, s.name]));
    const fromDate = parseDateOnly(from);
    const toDate = parseDateOnly(to);
    const today = this.days.today();

    const { punches, legacy, workers, gangs } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const punches = await tx.labourPunch.findMany({
          where: {
            siteId: { in: siteIds },
            punchDate: { gte: fromDate, lte: toDate },
          },
        });
        // Days marked on a muster before face punches: no times, but still the record of the day.
        const legacy = await tx.musterLine.findMany({
          where: {
            muster: {
              siteId: { in: siteIds },
              date: { gte: fromDate, lte: toDate },
              source: { not: MusterSource.face_punch },
              status: MusterStatus.approved,
              deletedAt: null,
            },
          },
          include: { muster: { select: { date: true, siteId: true } } },
        });
        const seen = [
          ...punches.map((p) => p.workerId),
          ...legacy.map((l) => l.workerId),
        ];
        const workers = await tx.labourWorker.findMany({
          where: {
            deletedAt: null,
            OR: [
              { siteId: { in: siteIds }, status: WorkerStatus.active },
              { id: { in: Array.from(new Set(seen)) } },
            ],
          },
          orderBy: { labourCode: 'asc' },
        });
        const gangs = await tx.gangMember.findMany({
          where: { workerId: { in: workers.map((w) => w.id) }, isActive: true },
          include: { gang: { select: { name: true, deletedAt: true } } },
        });
        return { punches, legacy, workers, gangs };
      },
    );

    const names = await this.refs.userNames(punches.map((p) => p.supervisorId));
    const contractors = await this.refs.contractorNames(
      caller,
      workers.map((w) => w.contractorId),
    );
    const gangName = new Map(
      gangs
        .filter((g) => !g.gang.deletedAt)
        .map((g) => [g.workerId, g.gang.name]),
    );
    const rulesByCompany = new Map<string, LabourDayRules>();
    const rulesFor = async (companyId: string) => {
      let rules = rulesByCompany.get(companyId);
      if (!rules) {
        rules = await this.refs.getDayRules(companyId);
        rulesByCompany.set(companyId, rules);
      }
      return rules;
    };

    // worker|site → date → punches
    const byKey = new Map<
      string,
      Map<string, { in?: (typeof punches)[0]; out?: (typeof punches)[0] }>
    >();
    for (const p of punches) {
      const key = `${p.workerId}|${p.siteId}`;
      const byDate = byKey.get(key) ?? new Map();
      const date = p.punchDate.toISOString().slice(0, 10);
      const entry = byDate.get(date) ?? {};
      entry[p.type] = p;
      byDate.set(date, entry);
      byKey.set(key, byDate);
    }
    const legacyByKey = new Map<string, Map<string, AttendanceType>>();
    for (const l of legacy) {
      const key = `${l.workerId}|${l.muster.siteId}`;
      const byDate = legacyByKey.get(key) ?? new Map();
      byDate.set(l.muster.date.toISOString().slice(0, 10), l.attendanceType);
      legacyByKey.set(key, byDate);
    }

    const fact = (p?: (typeof punches)[0]): PunchFact | null =>
      p
        ? {
            at: p.punchedAt.toISOString(),
            source: p.source,
            corrected: p.correctedAt !== null,
            recordedBy: names.get(p.supervisorId) ?? null,
            outsideFence: p.geofenceViolation,
          }
        : null;

    const out: { ref: MusterWorkerRef; days: Map<string, MusterDay> }[] = [];
    for (const w of workers) {
      const rules = await rulesFor(w.companyId);
      const keys = new Set<string>();
      for (const key of [...byKey.keys(), ...legacyByKey.keys()]) {
        if (key.startsWith(`${w.id}|`)) keys.add(key);
      }
      if (keys.size === 0 && siteIds.includes(w.siteId))
        keys.add(`${w.id}|${w.siteId}`);
      for (const key of keys) {
        const siteId = key.split('|')[1];
        if (!siteIds.includes(siteId)) continue;
        const days = new Map<string, MusterDay>();
        for (const [date, entry] of byKey.get(key) ?? []) {
          const derived = deriveLabourDay(
            entry.in?.punchedAt ?? null,
            entry.out?.punchedAt ?? null,
            date < today,
            rules,
          );
          days.set(date, {
            date,
            punchIn: fact(entry.in),
            punchOut: fact(entry.out),
            ...derived,
            manual: false,
          });
        }
        for (const [date, type] of legacyByKey.get(key) ?? []) {
          if (days.has(date)) continue;
          days.set(date, legacyDay(date, type));
        }
        out.push({
          ref: {
            workerId: w.id,
            labourCode: w.labourCode,
            fullName: w.fullName,
            fatherName: w.fatherName,
            gender: w.gender,
            contractorName: w.contractorId
              ? contractors.get(w.contractorId) ?? null
              : null,
            gangName: gangName.get(w.id) ?? null,
            siteId,
            siteName: siteName.get(siteId) ?? '',
          },
          days,
        });
      }
    }
    return out;
  }

  // ── Corrections ─────────────────────────────────────────────────────────────

  /**
   * Adds a missing punch or changes a wrong one, with a mandatory reason. The old and new times, who
   * made the change and when are kept in `LabourPunchCorrection`, and the day's muster line is
   * re-counted. A day a payment sheet already covers cannot be changed.
   */
  async correct(
    caller: AuthenticatedUser,
    dto: {
      workerId: string;
      date: string;
      punchIn?: string;
      punchOut?: string;
      /** 036 O5: the punch out is on the next calendar day — a night shift. */
      punchOutNextDay?: boolean;
      reason: string;
    },
    ipAddress: string,
  ): Promise<MusterDailyRow> {
    const reason = dto.reason?.trim() ?? '';
    if (reason.length < 3) {
      throw new BadRequestException('Give a reason for the correction.');
    }
    if (!dto.punchIn && !dto.punchOut) {
      throw new BadRequestException(
        'Enter the punch in time, the punch out time, or both.',
      );
    }
    const today = this.days.today();
    if (dto.date > today) {
      throw new BadRequestException('That date has not happened yet.');
    }

    const { worker, existing } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => ({
        worker: await tx.labourWorker.findUnique({
          where: { id: dto.workerId },
        }),
        existing: await tx.labourPunch.findMany({
          where: { workerId: dto.workerId, punchDate: parseDateOnly(dto.date) },
        }),
      }),
    );
    if (!worker || worker.deletedAt) {
      throw new NotFoundException('Labour not found');
    }
    assertInScope(caller, worker, 'Labour');
    // The day belongs to the site it was punched at; a day with no punch at all, to the worker's site.
    const siteId = existing[0]?.siteId ?? worker.siteId;
    await this.supervisorSites.assertSiteAllowed(caller, siteId);

    if (dto.punchOutNextDay && !dto.punchOut) {
      throw new BadRequestException(
        'Enter the punch out time to mark it as on the next day.',
      );
    }
    // Times are read in the company's zone (IST), whatever the browser's, and a next-day punch out
    // on the following calendar day there (036 O5).
    const { start } = zonedDayBounds(dto.date, this.refs.timeZone);
    const nextDay = zonedDayBounds(
      nextDate(dto.date),
      this.refs.timeZone,
    ).start;
    const toInstant = (hhmm: string, from: Date = start) => {
      const [h, m] = hhmm.split(':').map(Number);
      return new Date(from.getTime() + (h * 60 + m) * 60_000);
    };
    const wanted: Partial<Record<LabourPunchType, Date>> = {};
    if (dto.punchIn) wanted.in = toInstant(dto.punchIn);
    if (dto.punchOut) {
      wanted.out = toInstant(
        dto.punchOut,
        dto.punchOutNextDay ? nextDay : start,
      );
    }
    const now = new Date();
    for (const t of Object.values(wanted)) {
      if (t.getTime() > now.getTime()) {
        throw new BadRequestException('A punch time cannot be in the future.');
      }
    }

    const geofence = await this.refs.getSiteGeofence(caller, siteId);
    const rules = await this.refs.getDayRules(worker.companyId);
    const punchDate = parseDateOnly(dto.date);
    const changes: {
      type: LabourPunchType;
      from: string | null;
      to: string;
    }[] = [];

    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`labour-muster:${siteId}:${dto.date}`}))`;
      await this.days.assertNotOnPaymentSheet(tx, {
        companyId: worker.companyId,
        siteId,
        punchDate,
      });
      const clash = await tx.musterLine.findFirst({
        where: {
          workerId: worker.id,
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
            'This labour is on a muster for that day that was entered another way.',
        });
      }

      const current = await tx.labourPunch.findMany({
        where: { workerId: worker.id, punchDate },
      });
      for (const type of [LabourPunchType.in, LabourPunchType.out]) {
        const at = wanted[type];
        if (!at) continue;
        const punch = current.find((p) => p.type === type);
        if (punch && punch.punchedAt.getTime() === at.getTime()) continue;
        if (punch) {
          await tx.labourPunch.update({
            where: { id: punch.id },
            data: { punchedAt: at, correctedAt: now },
          });
        } else {
          await tx.labourPunch.create({
            data: {
              companyId: worker.companyId,
              workerId: worker.id,
              siteId,
              punchDate,
              type,
              punchedAt: at,
              supervisorId: caller.id,
              source: LabourPunchSource.correction,
              correctedAt: now,
            },
          });
        }
        await tx.labourPunchCorrection.create({
          data: {
            companyId: worker.companyId,
            workerId: worker.id,
            siteId,
            punchDate,
            type,
            oldPunchedAt: punch?.punchedAt ?? null,
            newPunchedAt: at,
            reason,
            correctedById: caller.id,
          },
        });
        changes.push({
          type,
          from: punch?.punchedAt.toISOString() ?? null,
          to: at.toISOString(),
        });
      }
      if (changes.length === 0) {
        throw new BadRequestException('Those are already the recorded times.');
      }

      const after = await tx.labourPunch.findMany({
        where: { workerId: worker.id, punchDate },
      });
      const pin = after.find((p) => p.type === LabourPunchType.in);
      const pout = after.find((p) => p.type === LabourPunchType.out);
      if (pin && pout && pout.punchedAt.getTime() <= pin.punchedAt.getTime()) {
        throw new BadRequestException({
          code: 'LABOUR_PUNCH_OUT_BEFORE_IN',
          message:
            'The punch out must be after the punch in. For a night shift, mark the punch out as on the next day.',
        });
      }
      // 036 O5: a shift into the next day is held to the same 16 hours a live punch-out is.
      if (
        pin &&
        pout &&
        pout.punchedAt.getTime() - pin.punchedAt.getTime() >
          OVERNIGHT_WINDOW_HOURS * 3_600_000 &&
        zonedDateOnly(pout.punchedAt, this.refs.timeZone) !== dto.date
      ) {
        throw new BadRequestException({
          code: 'LABOUR_SHIFT_TOO_LONG',
          message: `A shift that ends the next day can be at most ${OVERNIGHT_WINDOW_HOURS} hours long.`,
        });
      }

      await this.days.syncDay(tx, {
        companyId: worker.companyId,
        workerId: worker.id,
        siteId,
        punchDate,
        rules,
        actorId: caller.id,
        latitude: geofence.latitude,
        longitude: geofence.longitude,
        skillCategoryIdOnDay: worker.skillCategoryId,
      });
    });

    await this.auditLog.record({
      entityType: AuditEntityType.MUSTER_ROLL,
      action: AuditAction.UPDATE,
      entityId: worker.id,
      accountId: caller.id,
      companyId: worker.companyId,
      ipAddress,
      changes: {
        labourPunchCorrection: changes,
        date: dto.date,
        siteId,
        reason,
      },
    });

    const sites = await this.supervisorSites.mySites(caller);
    const site = sites.find((s) => s.id === siteId) ?? { id: siteId, name: '' };
    const grid = await this.collect(caller, [site], dto.date, dto.date);
    const row = grid.find((g) => g.ref.workerId === worker.id);
    if (!row) throw new NotFoundException('Labour not found');
    return { ...row.ref, ...(row.days.get(dto.date) ?? emptyDay(dto.date)) };
  }

  /** The edits to one worker's day, newest first. */
  async history(caller: AuthenticatedUser, workerId: string, date: string) {
    const { worker, rows } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => ({
        worker: await tx.labourWorker.findUnique({ where: { id: workerId } }),
        rows: await tx.labourPunchCorrection.findMany({
          where: { workerId, punchDate: parseDateOnly(date) },
          orderBy: { createdAt: 'desc' },
        }),
      }),
    );
    if (!worker || worker.deletedAt) {
      throw new NotFoundException('Labour not found');
    }
    assertInScope(caller, worker, 'Labour');
    await this.supervisorSites.assertSiteAllowed(
      caller,
      rows[0]?.siteId ?? worker.siteId,
    );
    const names = await this.refs.userNames(rows.map((r) => r.correctedById));
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      oldPunchedAt: r.oldPunchedAt?.toISOString() ?? null,
      newPunchedAt: r.newPunchedAt.toISOString(),
      reason: r.reason,
      correctedBy: names.get(r.correctedById) ?? null,
      correctedAt: r.createdAt.toISOString(),
    }));
  }

  // ── Day rules ───────────────────────────────────────────────────────────────

  async getRules(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<LabourDayRules> {
    return this.refs.getDayRules(resolveCompanyId(caller, companyId));
  }

  /**
   * Changes the thresholds and re-counts every punched day no payment sheet covers yet, so the
   * muster lines a future sheet will price follow the new rule. Days already on a sheet were paid
   * as they stood and are left alone.
   */
  async setRules(
    caller: AuthenticatedUser,
    rules: LabourDayRules,
    companyId: string | undefined,
    ipAddress: string,
  ): Promise<LabourDayRules & { recounted: number }> {
    const problem = labourDayRulesProblem(rules);
    if (problem) throw new BadRequestException(problem);
    const id = resolveCompanyId(caller, companyId);
    const before = await this.refs.getDayRules(id);
    await this.refs.setDayRules(id, rules);

    const ctx = { ...rlsContextFor(caller), companyId: id };
    const { days, sheets } = await withRlsContext(
      this.prisma,
      ctx,
      async (tx) => ({
        days: await tx.labourPunch.findMany({
          where: { companyId: id },
          distinct: ['workerId', 'siteId', 'punchDate'],
          select: { workerId: true, siteId: true, punchDate: true },
        }),
        sheets: await tx.labourPaymentSheet.findMany({
          where: { companyId: id, deletedAt: null },
          select: { siteId: true, periodFrom: true, periodTo: true },
        }),
      }),
    );
    const covered = (siteId: string, date: Date) =>
      sheets.some(
        (s) =>
          (s.siteId === siteId || s.siteId === null) &&
          s.periodFrom <= date &&
          s.periodTo >= date,
      );
    const open = days.filter((d) => !covered(d.siteId, d.punchDate));
    const geofences = new Map<
      string,
      { latitude: number; longitude: number }
    >();
    for (const d of open) {
      if (!geofences.has(d.siteId)) {
        geofences.set(
          d.siteId,
          await this.refs.getSiteGeofence(caller, d.siteId),
        );
      }
    }
    for (let i = 0; i < open.length; i += 200) {
      await withRlsContext(this.prisma, ctx, async (tx) => {
        for (const d of open.slice(i, i + 200)) {
          const g = geofences.get(d.siteId);
          await this.days.syncDay(tx, {
            companyId: id,
            workerId: d.workerId,
            siteId: d.siteId,
            punchDate: d.punchDate,
            rules,
            actorId: caller.id,
            latitude: g?.latitude ?? 0,
            longitude: g?.longitude ?? 0,
          });
        }
      });
    }

    await this.auditLog.record({
      entityType: AuditEntityType.COMPANY,
      action: AuditAction.UPDATE,
      entityId: id,
      accountId: caller.id,
      companyId: id,
      ipAddress,
      changes: {
        labourDayRules: { from: { ...before }, to: { ...rules } },
        recounted: open.length,
      },
    });
    return { ...rules, recounted: open.length };
  }

  // ── Group photos (reference only) ───────────────────────────────────────────

  /** A group photo for reference. Nobody is matched or marked from it. */
  async addSitePhoto(
    caller: AuthenticatedUser,
    dto: {
      siteId: string;
      photo: string;
      note?: string;
      latitude?: number;
      longitude?: number;
    },
  ) {
    await this.supervisorSites.assertSiteAllowed(caller, dto.siteId);
    // The photo belongs to the site's company, whoever takes it.
    const companyId = await this.refs.getSiteCompanyId(caller, dto.siteId);
    const image = await this.images.compressPunchPhoto(
      decodePhotoPayload(dto.photo, 'Group photo'),
    );
    const photoRef = await this.storage.put(
      LABOUR_SITE_PHOTO_NAMESPACE,
      image,
      'image/jpeg',
    );
    try {
      const row = await withRlsContext(
        this.prisma,
        rlsContextFor(caller),
        (tx) =>
          tx.labourSitePhoto.create({
            data: {
              companyId,
              siteId: dto.siteId,
              photoDate: parseDateOnly(this.days.today()),
              photoRef,
              note: dto.note?.trim() || null,
              latitude: dto.latitude ?? null,
              longitude: dto.longitude ?? null,
              takenById: caller.id,
            },
          }),
      );
      return this.photoView(row, await this.refs.userNames([caller.id]));
    } catch (err) {
      await this.storage.delete(photoRef).catch(() => undefined);
      throw err;
    }
  }

  async listSitePhotos(
    caller: AuthenticatedUser,
    siteId: string,
    date?: string,
  ) {
    await this.supervisorSites.assertSiteAllowed(caller, siteId);
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourSitePhoto.findMany({
          where: {
            siteId,
            ...(date ? { photoDate: parseDateOnly(date) } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
    );
    const names = await this.refs.userNames(rows.map((r) => r.takenById));
    return rows.map((r) => this.photoView(r, names));
  }

  async sitePhotoImage(caller: AuthenticatedUser, id: string): Promise<Buffer> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.labourSitePhoto.findUnique({ where: { id } }),
    );
    if (!row) throw new NotFoundException('Photo not found');
    assertInScope(caller, row, 'Photo');
    await this.supervisorSites.assertSiteAllowed(caller, row.siteId);
    return this.storage.get(row.photoRef);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async chosenSites(
    caller: AuthenticatedUser,
    siteId?: string,
  ): Promise<SiteOption[]> {
    const sites = await this.supervisorSites.mySites(caller);
    if (!siteId) {
      if (sites.length === 0) {
        throw new BadRequestException('You have no sites to show.');
      }
      return sites;
    }
    const site = sites.find((s) => s.id === siteId);
    if (!site) {
      await this.supervisorSites.assertSiteAllowed(caller, siteId);
      throw new NotFoundException('Site not found');
    }
    return [site];
  }

  private photoView(
    r: {
      id: string;
      siteId: string;
      photoDate: Date;
      note: string | null;
      takenById: string;
      createdAt: Date;
    },
    names: Map<string, string>,
  ) {
    return {
      id: r.id,
      siteId: r.siteId,
      date: r.photoDate.toISOString().slice(0, 10),
      note: r.note,
      takenBy: names.get(r.takenById) || null,
      takenAt: r.createdAt.toISOString(),
    };
  }
}

function emptyDay(date: string): MusterDay {
  return {
    date,
    punchIn: null,
    punchOut: null,
    hours: null,
    status: 'absent',
    overtimeHours: 0,
    flag: null,
    manual: false,
  };
}

function legacyDay(date: string, type: AttendanceType): MusterDay {
  const status: LabourDayStatus =
    type === AttendanceType.full_day
      ? 'full_day'
      : type === AttendanceType.half_day
      ? 'half_day'
      : 'absent';
  return { ...emptyDay(date), status, manual: true };
}

function summarise(rows: MusterDay[]): MusterSummary {
  const count = (s: LabourDayStatus) =>
    rows.filter((r) => r.status === s).length;
  return {
    workers: rows.length,
    present: count('full_day') + count('half_day'),
    fullDay: count('full_day'),
    halfDay: count('half_day'),
    short: count('short'),
    onSite: count('on_site'),
    absent: count('absent'),
    missingPunchOut: rows.filter((r) => r.flag === 'missing_punch_out').length,
    otherFlags: rows.filter(
      (r) => r.flag !== null && r.flag !== 'missing_punch_out',
    ).length,
    overtimeHours: round2(sum(rows.map((r) => r.overtimeHours))),
  };
}

function matches(row: MusterDay, filter: MusterFilter): boolean {
  switch (filter) {
    case 'missing_punch_out':
      return row.flag === 'missing_punch_out';
    case 'flagged':
      return row.flag !== null;
    case 'present':
      return row.status === 'full_day' || row.status === 'half_day';
    default:
      return row.status === filter;
  }
}

function monthTotals(days: MusterDay[]): MusterMonthTotals {
  const full = days.filter((d) => d.status === 'full_day').length;
  const half = days.filter((d) => d.status === 'half_day').length;
  return {
    fullDays: full,
    halfDays: half,
    shortDays: days.filter((d) => d.status === 'short').length,
    unresolved: days.filter((d) => d.status === 'unresolved').length,
    payableDays: full + half * 0.5,
    hours: round2(sum(days.map((d) => d.hours ?? 0))),
    overtimeHours: round2(sum(days.map((d) => d.overtimeHours))),
  };
}

export function monthRange(year: number, month: number) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(last).padStart(2, '0')}`,
    daysInMonth: last,
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** The calendar day after `YYYY-MM-DD`. */
function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
