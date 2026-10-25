import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  HireBillStatus,
  MeterType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { assertInService } from '../disposal/in-service';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { businessToday } from '../../common/business-date';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/plant.constants';
import { EquipmentService } from '../equipment/equipment.service';
import { PlantRefsService } from '../plant-refs.service';
import { hasReadingGap, readingProblem } from './logbook-readings';
import {
  CorrectLogbookReadingsDto,
  CreateLogbookEntryDto,
  ListLogbookDto,
} from './dto/logbook.dto';

export interface LogbookRow {
  id: string;
  companyId: string;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  date: Date;
  openingReading: number;
  closingReading: number;
  totalHours: number;
  fuelConsumed: number | null;
  operatorId: string | null;
  operatorName: string | null;
  projectId: string | null;
  remarks: string | null;
  /** Why the opening reading does not follow the previous closing one (036 K4). */
  readingGapReason: string | null;
  createdAt: Date;
}

/** A created entry with its equipment joined — what `createInTx` returns and `auditCreated` reads. */
export type CreatedLogbookEntry = Prisma.LogbookEntryGetPayload<{
  include: { equipment: { select: { code: true; name: true } } };
}>;

/**
 * The daily logbook (006 US3).
 *
 * Three things happen on every write, and they are one transaction on purpose: the
 * entry is recorded, the machine's `currentReading` is brought up to date, and its
 * utilisation % is recomputed for the month (FR-007). A crash between any two would
 * leave the register describing a machine that the logbook contradicts.
 */
@Injectable()
export class LogbookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: PlantRefsService,
    private readonly equipment: EquipmentService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: ListLogbookDto,
  ): Promise<{
    items: LogbookRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.LogbookEntryWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.equipmentId ? { equipmentId: query.equipmentId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            date: {
              ...(query.dateFrom
                ? { gte: this.refs.parseDate(query.dateFrom) }
                : {}),
              ...(query.dateTo
                ? { lte: this.refs.parseDate(query.dateTo) }
                : {}),
            },
          }
        : {}),
    };

    const { rows, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.logbookEntry.findMany({
            where,
            orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: { equipment: { select: { code: true, name: true } } },
          }),
          tx.logbookEntry.count({ where }),
        ]);
        return { rows, total };
      },
    );

    const operatorNames = await this.refs.employeeNames(
      caller,
      rows.flatMap((row) => (row.operatorId ? [row.operatorId] : [])),
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        equipmentId: row.equipmentId,
        equipmentCode: row.equipment.code,
        equipmentName: row.equipment.name,
        date: row.date,
        openingReading: Number(row.openingReading),
        closingReading: Number(row.closingReading),
        totalHours: Number(row.totalHours),
        fuelConsumed:
          row.fuelConsumed === null ? null : Number(row.fuelConsumed),
        operatorId: row.operatorId,
        operatorName: row.operatorId
          ? operatorNames.get(row.operatorId) ?? 'Unknown operator'
          : null,
        projectId: row.projectId,
        remarks: row.remarks,
        readingGapReason: row.readingGapReason,
        createdAt: row.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateLogbookEntryDto,
    ipAddress: string,
  ): Promise<LogbookRow> {
    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => this.createInTx(caller, dto, tx),
    );
    await this.auditCreated(caller, created, ipAddress);
    return this.toRow(caller, created);
  }

  /**
   * The transactional core of `create` (042): every check and write, against the
   * caller's transaction client. Extracted so the monthly sheet can write a whole
   * month's entries in **one** transaction — a failure on any row rolls back every
   * row — while the single-entry route keeps opening its own.
   *
   * The audit entry is deliberately NOT written here: it goes to the shared audit
   * table outside this transaction, so one recorded here would survive a rollback and
   * describe an entry that never existed. Callers record it with `auditCreated` after
   * their transaction commits.
   */
  async createInTx(
    caller: AuthenticatedUser,
    dto: CreateLogbookEntryDto,
    tx: Prisma.TransactionClient,
  ): Promise<CreatedLogbookEntry> {
    if (dto.closingReading < dto.openingReading) {
      throw new BadRequestException(
        'closingReading cannot be less than openingReading — a meter does not run backwards.',
      );
    }
    const date = this.refs.parseDate(dto.date);

    const equipment = await tx.equipment.findUnique({
      where: { id: dto.equipmentId },
    });
    if (!equipment) {
      throw new BadRequestException(
        `Equipment ${dto.equipmentId} does not exist.`,
      );
    }
    assertInScope(caller, equipment, 'Equipment');
    assertInService(equipment);

    // Checked before inserting so the caller gets a useful message; the UNIQUE
    // index behind it (FR-003) is what makes the guarantee real under
    // concurrency.
    const clash = await tx.logbookEntry.findUnique({
      where: {
        equipmentId_date: { equipmentId: dto.equipmentId, date },
      },
    });
    if (clash) {
      throw new ConflictException(
        `${equipment.code} already has a logbook entry for ${dto.date.slice(
          0,
          10,
        )}. ` +
          'One entry per machine per day — edit the existing one instead.',
      );
    }

    await this.assertNotBilled(
      tx,
      { equipmentId: dto.equipmentId, date },
      'added',
    );

    if (dto.operatorId) {
      await this.refs.requireEmployee(
        caller,
        dto.operatorId,
        equipment.companyId,
      );
    }
    // 036 K2: the project must be one of the machine's company's — the same check fuel,
    // hire orders and job cards make. Unchecked, an entry could carry any project id at all,
    // including another company's, and its hours would land in that project's costs.
    if (dto.projectId) {
      await this.refs.requireProject(
        caller,
        dto.projectId,
        equipment.companyId,
      );
    }

    // 036 K4. The previous entry is the latest one *before* this date, so a backdated entry
    // is checked against the day before it, not against whatever was entered last.
    const previous = await tx.logbookEntry.findFirst({
      where: { equipmentId: dto.equipmentId, date: { lt: date } },
      orderBy: { date: 'desc' },
      select: { closingReading: true },
    });
    const previousClosing = previous ? Number(previous.closingReading) : null;
    const problem = readingProblem({
      date: dto.date.slice(0, 10),
      dateValue: date,
      today: businessToday(),
      meterType: equipment.meterType,
      openingReading: dto.openingReading,
      closingReading: dto.closingReading,
      previousClosing,
      readingGapReason: dto.readingGapReason,
    });
    if (problem) throw new BadRequestException(problem);

    const entry = await tx.logbookEntry.create({
      data: {
        companyId: equipment.companyId,
        equipmentId: dto.equipmentId,
        date,
        openingReading: dto.openingReading,
        closingReading: dto.closingReading,
        totalHours: dto.closingReading - dto.openingReading,
        fuelConsumed: dto.fuelConsumed ?? null,
        operatorId: dto.operatorId ?? null,
        projectId: dto.projectId ?? null,
        remarks: dto.remarks ?? null,
        readingGapReason: hasReadingGap(dto.openingReading, previousClosing)
          ? dto.readingGapReason?.trim() ?? null
          : null,
      },
      include: { equipment: { select: { code: true, name: true } } },
    });

    await this.syncEquipmentFromLogbook(tx, caller, dto.equipmentId);
    return entry;
  }

  /** The audit entry for a created entry, recorded once the writing transaction committed. */
  async auditCreated(
    caller: AuthenticatedUser,
    created: CreatedLogbookEntry,
    ipAddress: string,
  ): Promise<void> {
    await this.auditLog.record({
      entityType: AuditEntityType.LOGBOOK_ENTRY,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
      changes: {
        equipmentId: created.equipmentId,
        date: created.date.toISOString().slice(0, 10),
        totalHours: Number(created.totalHours),
      },
    });
  }

  /**
   * Corrects a day's opening and closing readings in place (036 K6).
   *
   * The same rules as recording the day: not inside a verified or paid hire bill, closing not
   * below opening, at most 24 h on an hour meter, and an opening that follows the previous closing
   * reading unless a gap reason is given. The machine's meter and utilisation are re-derived in the
   * same transaction, and the audit entry carries the reason with the readings before and after —
   * the only record of what the figures were.
   *
   * The *next* day's opening reading IS re-checked (042; it used to be left to the screen's
   * "check the following day" note, which nobody reads): a correction whose new closing
   * figure the following entry's opening no longer follows — with no gap reason recorded on
   * that entry — is refused, naming the day. The two days are fixed next-day-first: the next
   * day's own correction can carry a gap reason, so there is no deadlock.
   */
  async correctReadings(
    caller: AuthenticatedUser,
    entryId: string,
    dto: CorrectLogbookReadingsDto,
    ipAddress: string,
  ): Promise<LogbookRow> {
    const reason = dto.reason.trim();
    if (!reason) {
      throw new BadRequestException(
        'Give a reason for correcting the readings.',
      );
    }
    if (dto.closingReading < dto.openingReading) {
      throw new BadRequestException(
        'closingReading cannot be less than openingReading — a meter does not run backwards.',
      );
    }

    const { before, updated } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.logbookEntry.findUnique({
          where: { id: entryId },
        });
        if (!existing) throw new NotFoundException('Logbook entry not found');
        assertInScope(caller, existing, 'Logbook entry');
        await this.assertNotBilled(tx, existing, 'edited');

        const equipment = await tx.equipment.findUnique({
          where: { id: existing.equipmentId },
          select: { meterType: true },
        });
        const previous = await tx.logbookEntry.findFirst({
          where: {
            equipmentId: existing.equipmentId,
            date: { lt: existing.date },
          },
          orderBy: { date: 'desc' },
          select: { closingReading: true },
        });
        const previousClosing = previous
          ? Number(previous.closingReading)
          : null;
        const day = existing.date.toISOString().slice(0, 10);
        const problem = readingProblem({
          date: day,
          dateValue: existing.date,
          // The entry already exists, so its date passed the future check when it was recorded;
          // a row from before that rule is still correctable.
          today:
            existing.date > businessToday() ? existing.date : businessToday(),
          meterType: equipment?.meterType ?? MeterType.hours,
          openingReading: dto.openingReading,
          closingReading: dto.closingReading,
          previousClosing,
          readingGapReason: dto.readingGapReason ?? existing.readingGapReason,
        });
        if (problem) throw new BadRequestException(problem);

        // 042: the next day's opening reading was accepted against the closing figure this
        // correction changes, so it is re-checked here. A correction that would leave the
        // following entry's opening unexplained is refused, naming the day — correct that
        // day first (giving it a gap reason there if the jump is real), then retry.
        const next = await tx.logbookEntry.findFirst({
          where: {
            equipmentId: existing.equipmentId,
            date: { gt: existing.date },
          },
          orderBy: { date: 'asc' },
          select: { date: true, openingReading: true, readingGapReason: true },
        });
        if (
          next &&
          hasReadingGap(Number(next.openingReading), dto.closingReading) &&
          !next.readingGapReason?.trim()
        ) {
          const nextDay = next.date.toISOString().slice(0, 10);
          throw new BadRequestException(
            `${nextDay}'s opening reading ${Number(
              next.openingReading,
            )} would no longer follow this day's corrected closing reading ${
              dto.closingReading
            }. Correct ${nextDay}'s readings first — give that day a gap reason if the ` +
              'jump is real — then retry this correction.',
          );
        }

        const gapReason = hasReadingGap(dto.openingReading, previousClosing)
          ? (dto.readingGapReason ?? existing.readingGapReason)?.trim() ?? null
          : null;

        const row = await tx.logbookEntry.update({
          where: { id: entryId },
          data: {
            openingReading: dto.openingReading,
            closingReading: dto.closingReading,
            totalHours: dto.closingReading - dto.openingReading,
            readingGapReason: gapReason,
          },
          include: { equipment: { select: { code: true, name: true } } },
        });
        await this.syncEquipmentFromLogbook(tx, caller, existing.equipmentId);
        return { before: existing, updated: row };
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LOGBOOK_ENTRY,
      action: AuditAction.UPDATE,
      entityId: entryId,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
      changes: {
        kind: 'readings_corrected',
        reason,
        equipmentId: updated.equipmentId,
        date: updated.date.toISOString().slice(0, 10),
        before: {
          openingReading: Number(before.openingReading),
          closingReading: Number(before.closingReading),
          totalHours: Number(before.totalHours),
          readingGapReason: before.readingGapReason,
        },
        after: {
          openingReading: Number(updated.openingReading),
          closingReading: Number(updated.closingReading),
          totalHours: Number(updated.totalHours),
          readingGapReason: updated.readingGapReason,
        },
      },
    });
    return this.toRow(caller, updated);
  }

  async remove(
    caller: AuthenticatedUser,
    entryId: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.logbookEntry.findUnique({
          where: { id: entryId },
        });
        if (!existing) throw new NotFoundException('Logbook entry not found');
        assertInScope(caller, existing, 'Logbook entry');
        await this.assertNotBilled(tx, existing, 'deleted');

        await tx.logbookEntry.delete({ where: { id: entryId } });
        await this.syncEquipmentFromLogbook(tx, caller, existing.equipmentId);
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LOGBOOK_ENTRY,
      action: AuditAction.DELETE,
      entityId: entryId,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
      // The whole row (036 K5). A delete is the one change after which the entry itself is gone,
      // so the audit trail is the only place its readings survive — the equipment id alone said
      // that something was deleted, and nothing about what.
      changes: {
        equipmentId: removed.equipmentId,
        before: {
          id: removed.id,
          date: removed.date.toISOString().slice(0, 10),
          openingReading: Number(removed.openingReading),
          closingReading: Number(removed.closingReading),
          totalHours: Number(removed.totalHours),
          fuelConsumed:
            removed.fuelConsumed === null ? null : Number(removed.fuelConsumed),
          operatorId: removed.operatorId,
          projectId: removed.projectId,
          remarks: removed.remarks,
          readingGapReason: removed.readingGapReason,
          createdAt: removed.createdAt.toISOString(),
        },
      },
    });
  }

  /**
   * Brings a machine's `currentReading` and `utilizationPercent` back in step with
   * its logbook.
   *
   * `currentReading` is taken from the *latest-dated* surviving entry rather than
   * from whatever entry was just written. Blindly assigning the new closing reading
   * would let a backdated correction wind the meter backwards — and a wound-back
   * meter silently un-dues every service schedule on that machine.
   *
   * A machine whose last entry was just deleted falls back to the opening reading of
   * nothing at all, so the reading is left where it is: there is no honest value to
   * move it to, and zeroing it would be worse than stale.
   */
  /**
   * Refuses to add, change or delete an entry a verified or paid hire bill was raised over (036 K5;
   * adding since review decision 9).
   *
   * The bill snapshots the logbook hours when it is raised, so editing or deleting an entry inside
   * its period afterwards leaves a bill that was verified against figures that no longer exist —
   * and once it is paid there is no way to tell what the payment was checked against. A bill
   * still awaiting verification does not block: correcting the logbook before verifying is the
   * point of verification.
   */
  async assertNotBilled(
    tx: Prisma.TransactionClient,
    entry: { equipmentId: string; date: Date },
    action: 'added' | 'edited' | 'deleted',
  ): Promise<void> {
    const bill = await tx.hireBill.findFirst({
      where: {
        equipmentId: entry.equipmentId,
        status: { in: [HireBillStatus.verified, HireBillStatus.paid] },
        billingPeriodFrom: { lte: entry.date },
        billingPeriodTo: { gte: entry.date },
      },
      select: {
        status: true,
        invoiceNo: true,
        billingPeriodFrom: true,
        billingPeriodTo: true,
      },
    });
    if (bill) {
      const period = `${bill.billingPeriodFrom
        .toISOString()
        .slice(0, 10)} to ${bill.billingPeriodTo.toISOString().slice(0, 10)}`;
      const billName = `a ${bill.status} hire bill${
        bill.invoiceNo ? ` (${bill.invoiceNo})` : ''
      } for ${period}`;
      // 036 review decision 9: adding is refused too. A day added to a verified period changes
      // the hours under a bill exactly as editing one does — the bill no longer matches its
      // logbook — and the paid bill can never account for it.
      throw new ConflictException(
        action === 'added'
          ? `${entry.date
              .toISOString()
              .slice(
                0,
                10,
              )} is inside ${billName}. An entry cannot be added to a billed period.`
          : `This entry is inside ${billName} and cannot be ${action}.`,
      );
    }
  }

  /**
   * The sheet's pre-check for review decision 9: refuses the whole save when any typed day falls
   * inside a verified or paid hire bill, before a single row is written. `create` checks again
   * per row inside its transaction; this is what keeps a sheet from half-saving up to that day.
   */
  async assertDaysNotBilled(
    caller: AuthenticatedUser,
    equipmentId: string,
    dates: string[],
  ): Promise<void> {
    if (dates.length === 0) return;
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      for (const date of [...dates].sort()) {
        await this.assertNotBilled(
          tx,
          { equipmentId, date: this.refs.parseDate(date) },
          'added',
        );
      }
    });
  }

  private async syncEquipmentFromLogbook(
    tx: Prisma.TransactionClient,
    caller: AuthenticatedUser,
    equipmentId: string,
  ): Promise<void> {
    // Entries dated after today are ignored (036 K4). Future dates are refused now, but rows
    // written before that rule — a typo year such as 2062 — would otherwise stay the "latest"
    // entry forever and hold the meter at their reading whatever was logged afterwards.
    const latest = await tx.logbookEntry.findFirst({
      where: { equipmentId, date: { lte: businessToday() } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      select: { closingReading: true },
    });
    if (latest) {
      await tx.equipment.update({
        where: { id: equipmentId },
        data: { currentReading: latest.closingReading },
      });
    }

    const equipment = await tx.equipment.findUnique({
      where: { id: equipmentId },
      select: { categoryId: true },
    });
    const category = equipment
      ? await tx.equipmentCategory.findUnique({
          where: { id: equipment.categoryId },
          select: { targetHoursPerMonth: true },
        })
      : null;

    await this.equipment.recomputeUtilisation(
      tx,
      caller,
      equipmentId,
      category?.targetHoursPerMonth ?? 0,
    );
  }

  private async toRow(
    caller: AuthenticatedUser,
    row: Prisma.LogbookEntryGetPayload<{
      include: { equipment: { select: { code: true; name: true } } };
    }>,
  ): Promise<LogbookRow> {
    const operatorName = row.operatorId
      ? (await this.refs.employeeNames(caller, [row.operatorId])).get(
          row.operatorId,
        ) ?? 'Unknown operator'
      : null;
    return {
      id: row.id,
      companyId: row.companyId,
      equipmentId: row.equipmentId,
      equipmentCode: row.equipment.code,
      equipmentName: row.equipment.name,
      date: row.date,
      openingReading: Number(row.openingReading),
      closingReading: Number(row.closingReading),
      totalHours: Number(row.totalHours),
      fuelConsumed: row.fuelConsumed === null ? null : Number(row.fuelConsumed),
      operatorId: row.operatorId,
      operatorName,
      projectId: row.projectId,
      remarks: row.remarks,
      readingGapReason: row.readingGapReason,
      createdAt: row.createdAt,
    };
  }
}
