import { ConflictException, Injectable } from '@nestjs/common';
import {
  LabourPunchType,
  MusterSource,
  MusterStatus,
  PaymentSheetStatus,
  Prisma,
} from '@prisma/client';

import { zonedDateOnly } from '../../hr/leave/leave-days';
import { LabourRefsService } from '../labour-refs.service';
import {
  deriveLabourDay,
  type LabourDay,
  type LabourDayRules,
  musterLineFor,
} from './labour-day.util';

const siteSheetLockKey = (siteId: string) => `labour-sheet-site:${siteId}`;

/**
 * Keeps a labour day's muster line in step with its punch times (034).
 *
 * The muster line is what payment sheets, labour reports and project costing price, so it is
 * written from the punches and never by hand: both punches in order → full, half or short by the
 * company's thresholds, with overtime beyond the standard shift; a missing punch → no line, so the
 * day is not counted until it is corrected.
 */
@Injectable()
export class LabourDayService {
  constructor(private readonly refs: LabourRefsService) {}

  /** Today in the company's zone, as `YYYY-MM-DD`. */
  today(): string {
    return zonedDateOnly(new Date(), this.refs.timeZone);
  }

  /** Re-derives one worker's day at a site and writes (or removes) its muster line. */
  async syncDay(
    tx: Prisma.TransactionClient,
    input: {
      companyId: string;
      workerId: string;
      siteId: string;
      punchDate: Date;
      rules: LabourDayRules;
      /** Who the roll is created for when the day has none yet. */
      actorId: string;
      /** Where the roll is pinned when the day has none yet. */
      latitude: number;
      longitude: number;
      accuracyMetres?: number;
      geofenceViolation?: boolean;
      skillCategoryIdOnDay?: string | null;
    },
  ): Promise<LabourDay> {
    const punches = await tx.labourPunch.findMany({
      where: { workerId: input.workerId, punchDate: input.punchDate },
    });
    const pin = punches.find((p) => p.type === LabourPunchType.in) ?? null;
    const pout = punches.find((p) => p.type === LabourPunchType.out) ?? null;
    const date = input.punchDate.toISOString().slice(0, 10);
    const day = deriveLabourDay(
      pin?.punchedAt ?? null,
      pout?.punchedAt ?? null,
      date < this.today(),
      input.rules,
    );
    const line = musterLineFor(day);

    const roll = await this.rollFor(tx, input);
    if (input.geofenceViolation && !roll.geofenceViolation) {
      await tx.musterRoll.update({
        where: { id: roll.id },
        data: { geofenceViolation: true },
      });
    }

    if (!line) {
      await tx.musterLine.deleteMany({
        where: { musterId: roll.id, workerId: input.workerId },
      });
      return day;
    }
    const photo = pin?.photoRef ?? pout?.photoRef ?? null;
    const score = pin?.faceMatchDistance ?? pout?.faceMatchDistance ?? null;
    await tx.musterLine.upsert({
      where: {
        musterId_workerId: { musterId: roll.id, workerId: input.workerId },
      },
      create: {
        companyId: input.companyId,
        musterId: roll.id,
        workerId: input.workerId,
        attendanceType: line.attendanceType,
        overtimeHours: line.overtimeHours,
        photoRef: photo,
        faceMatchScore: score,
        skillCategoryIdOnDay: input.skillCategoryIdOnDay ?? null,
      },
      update: {
        attendanceType: line.attendanceType,
        overtimeHours: line.overtimeHours,
      },
    });
    return day;
  }

  /**
   * Refuses to change a day a payment sheet already covers: the money for it has been worked out,
   * and changing the attendance underneath would leave the sheet and the muster disagreeing.
   *
   * 036 O3: takes the site's sheet lock shared first, so it holds until the caller's transaction
   * ends. A sheet being generated takes it exclusively (`lockSiteForSheet`), so either this check
   * sees the sheet, or the sheet waits for this change and then reads it — never neither. Shared,
   * so punches at a site do not queue behind one another.
   */
  async assertNotOnPaymentSheet(
    tx: Prisma.TransactionClient,
    input: { companyId: string; siteId: string; punchDate: Date },
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${siteSheetLockKey(
      input.siteId,
    )}))`;
    const sheet = await tx.labourPaymentSheet.findFirst({
      where: {
        companyId: input.companyId,
        deletedAt: null,
        periodFrom: { lte: input.punchDate },
        periodTo: { gte: input.punchDate },
        OR: [{ siteId: input.siteId }, { siteId: null }],
      },
      select: { id: true, periodFrom: true, periodTo: true, status: true },
    });
    if (sheet) {
      const range = `${sheet.periodFrom
        .toISOString()
        .slice(0, 10)} to ${sheet.periodTo.toISOString().slice(0, 10)}`;
      // 036 O2: a draft can now be deleted, and an approved sheet reopened to draft first — but a
      // sheet with a paid line can be neither, so the message says which applies.
      const how =
        sheet.status === PaymentSheetStatus.draft
          ? 'Delete that draft sheet, correct the day, then generate the sheet again.'
          : sheet.status === PaymentSheetStatus.approved
          ? 'Reopen that sheet and delete it while it is a draft, correct the day, then generate the sheet again.'
          : 'Part of that sheet has been paid, so the day can no longer be changed.';
      throw new ConflictException({
        code: 'LABOUR_DAY_ON_PAYMENT_SHEET',
        message: `A payment sheet for ${range} already covers this day. ${how}`,
        sheetId: sheet.id,
        sheetStatus: sheet.status,
      });
    }
  }

  /**
   * The exclusive side of the lock `assertNotOnPaymentSheet` takes shared: held by whatever decides
   * what a sheet for this site holds, for the length of its transaction.
   */
  async lockSiteForSheet(
    tx: Prisma.TransactionClient,
    siteId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${siteSheetLockKey(
      siteId,
    )}))`;
  }

  /**
   * Workers at a site with an unresolved earlier day between two dates: a missing punch, or a
   * punch out not after the punch in. A payment sheet over those dates would underpay them.
   */
  async unresolvedDays(
    tx: Prisma.TransactionClient,
    siteId: string,
    from: Date,
    to: Date,
  ): Promise<{ workerId: string; date: string }[]> {
    const punches = await tx.labourPunch.findMany({
      where: { siteId, punchDate: { gte: from, lte: to } },
      select: { workerId: true, punchDate: true, type: true, punchedAt: true },
    });
    const today = this.today();
    const days = new Map<string, { in?: Date; out?: Date }>();
    for (const p of punches) {
      const key = `${p.workerId}|${p.punchDate.toISOString().slice(0, 10)}`;
      const entry = days.get(key) ?? {};
      entry[p.type] = p.punchedAt;
      days.set(key, entry);
    }
    const out: { workerId: string; date: string }[] = [];
    for (const [key, d] of days) {
      const [workerId, date] = key.split('|');
      if (date >= today) continue;
      const missing = !d.in || !d.out || d.out.getTime() <= d.in.getTime();
      if (missing) out.push({ workerId, date });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  private async rollFor(
    tx: Prisma.TransactionClient,
    input: {
      companyId: string;
      siteId: string;
      punchDate: Date;
      actorId: string;
      latitude: number;
      longitude: number;
      accuracyMetres?: number;
    },
  ) {
    const existing = await tx.musterRoll.findFirst({
      where: {
        siteId: input.siteId,
        date: input.punchDate,
        source: MusterSource.face_punch,
        deletedAt: null,
      },
    });
    if (existing) return existing;
    const now = new Date();
    return tx.musterRoll.create({
      data: {
        companyId: input.companyId,
        siteId: input.siteId,
        date: input.punchDate,
        supervisorId: input.actorId,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracyMetres: input.accuracyMetres ?? 0,
        source: MusterSource.face_punch,
        capturedAt: now,
        status: MusterStatus.approved,
        approvedAt: now,
        createdBy: input.actorId,
      },
    });
  }
}
