import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  SalaryRevision,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import type { SettingsConfig } from '../../common/configs/config.interface';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../biometrics/face-enrolment.service';
import { zonedDateOnly } from '../leave/leave-days';
import type { CreateSalaryRevisionDto } from './dto/salary-revision.dto';

/** The five monthly heads, under the revision table's names. */
const HEADS = [
  'basic',
  'hra',
  'conveyance',
  'siteAllowance',
  'specialAllowance',
] as const;
export type SalaryHead = (typeof HEADS)[number];
type Head = SalaryHead;
export type SalaryHeads = Record<Head, Prisma.Decimal | null>;
type Heads = SalaryHeads;

/** The employee's salary columns, under the revision table's names. */
type EmployeeSalaryColumns = {
  basic: Prisma.Decimal | null;
  hra: Prisma.Decimal | null;
  conveyanceAllowance: Prisma.Decimal | null;
  siteAllowance: Prisma.Decimal | null;
  specialAllowance: Prisma.Decimal | null;
};

/** The names the employee form uses for the five heads — `conveyance` is the one that differs. */
export const EMPLOYEE_SALARY_COLUMNS = [
  'basic',
  'hra',
  'conveyanceAllowance',
  'siteAllowance',
  'specialAllowance',
] as const;

export function headsOfEmployee(employee: EmployeeSalaryColumns): SalaryHeads {
  return {
    basic: employee.basic,
    hra: employee.hra,
    conveyance: employee.conveyanceAllowance,
    siteAllowance: employee.siteAllowance,
    specialAllowance: employee.specialAllowance,
  };
}

function employeeColumnsOf(heads: SalaryHeads): EmployeeSalaryColumns {
  return {
    basic: heads.basic,
    hra: heads.hra,
    conveyanceAllowance: heads.conveyance,
    siteAllowance: heads.siteAllowance,
    specialAllowance: heads.specialAllowance,
  };
}

/** A revision as listed: the row, plus the monthly gross on either side of it. */
export type SalaryRevisionView = SalaryRevision & {
  /** Sum of the five `previous*` heads; a null head counts as zero. */
  previousGross: number;
  /** Sum of the five new heads; a null head counts as zero. */
  gross: number;
};

export const SALARY_REVISION_FUTURE_DATE = 'SALARY_REVISION_FUTURE_DATE';
export const SALARY_REVISION_BEFORE_LATEST = 'SALARY_REVISION_BEFORE_LATEST';
export const SALARY_REVISION_NO_CHANGE = 'SALARY_REVISION_NO_CHANGE';

/**
 * An employee's salary revision history — what the increment letter quotes as "with effect from"
 * and "revised from ₹X to ₹Y".
 *
 * ## The employee's columns stay the source of truth for payroll
 *
 * Payroll reads `Employee.basic`/`hra`/`conveyanceAllowance`/`siteAllowance`/`specialAllowance`
 * directly and knows nothing about this table. A revision therefore writes its new heads onto the
 * employee in the same transaction that records it, and snapshots the heads it replaced into
 * `previous*` — so the history and the pay can never disagree about what changed.
 *
 * ## Why a future effective date is refused
 *
 * Because the heads land on the employee *now*, a revision dated next month would be paid in this
 * month's run, before its date. Scheduling is not modelled; HR records a revision on or after the
 * day it takes effect. A backdated one is fine — payroll pays from the next run, and any arrears
 * are HR's call, as they were before this table existed.
 *
 * ## Append-only and ordered
 *
 * A revision earlier than the latest one is refused: the latest revision's heads are the
 * employee's current heads, and slotting an older one in behind it would make its `previous*`
 * snapshot describe pay the employee was not on at that date.
 */
@Injectable()
export class SalaryRevisionsService {
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
  }

  /**
   * Today's date in the business time zone, `YYYY-MM-DD` — the date a revision recorded "now"
   * takes effect from. Exposed so `EmployeesService.update` dates the revision it records the same
   * way this service bounds a future one.
   */
  today(): string {
    return zonedDateOnly(new Date(), this.timeZone);
  }

  /**
   * Writes one revision row inside the caller's transaction, or returns null when no head moved.
   *
   * The single place a `SalaryRevision` is created. `create` (the revisions endpoint) and
   * `EmployeesService.update` (a salary edited on the employee form, 2026-10-14) both come through
   * here, so the snapshot of the heads replaced and the heads that replaced them is taken the same
   * way whichever screen changed the pay. **It does not touch the employee row**: the revisions
   * endpoint writes the new heads itself, and the employee form's own update already has.
   *
   * No date-ordering checks either — those belong to the endpoint where HR chooses the date. A
   * revision recorded from the employee form is dated today, which cannot be in the future and
   * cannot precede a revision that was itself refused a future date.
   */
  async recordInTx(
    tx: Prisma.TransactionClient,
    input: {
      companyId: string;
      employeeId: string;
      /** `YYYY-MM-DD`. */
      effectiveFrom: string;
      previous: Heads;
      next: Heads;
      remarks: string | null;
      createdByUserId: string;
    },
  ): Promise<{ revision: SalaryRevision; changed: Head[] } | null> {
    const { previous, next } = input;
    const changed = HEADS.filter(
      (head) => !amountOf(previous[head]).equals(amountOf(next[head])),
    );
    if (changed.length === 0) return null;

    const revision = await tx.salaryRevision.create({
      data: {
        companyId: input.companyId,
        employeeId: input.employeeId,
        effectiveFrom: new Date(input.effectiveFrom),
        previousBasic: previous.basic,
        previousHra: previous.hra,
        previousConveyance: previous.conveyance,
        previousSiteAllowance: previous.siteAllowance,
        previousSpecialAllowance: previous.specialAllowance,
        basic: next.basic,
        hra: next.hra,
        conveyance: next.conveyance,
        siteAllowance: next.siteAllowance,
        specialAllowance: next.specialAllowance,
        remarks: input.remarks,
        createdByUserId: input.createdByUserId,
      },
    });
    return { revision, changed };
  }

  /** Every revision for one employee, newest effective date first. */
  async listFor(
    ctx: RlsContext,
    employeeId: string,
  ): Promise<SalaryRevisionView[]> {
    const rows = await withRlsContext(this.prisma, ctx, async (tx) => {
      const employee = await tx.employee.findFirst({
        where: { id: employeeId },
        select: { id: true },
      });
      if (!employee) throw new NotFoundException('Employee not found');
      return tx.salaryRevision.findMany({
        where: { employeeId },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      });
    });
    return rows.map(toView);
  }

  /**
   * The latest revision for one employee, or null when their pay has never been revised.
   *
   * Exported for the letters employee source (the increment letter's `revision.*` fields). Scoped
   * on `companyId` as well as the RLS context, so a cross-company caller asking about company A's
   * letter cannot be handed a row filed under company B.
   */
  async latestFor(
    ctx: RlsContext,
    companyId: string,
    employeeId: string,
  ): Promise<SalaryRevisionView | null> {
    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.salaryRevision.findFirst({
        where: { companyId, employeeId },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      }),
    );
    return row ? toView(row) : null;
  }

  /**
   * Records a revision and applies it to the employee, in one RLS transaction.
   *
   * The company is taken from the employee, never from the caller's input — a row filed against
   * another company would be invisible to every later read, since RLS scopes on `companyId`.
   */
  async create(
    caller: Caller,
    employeeId: string,
    dto: CreateSalaryRevisionDto,
  ): Promise<SalaryRevisionView> {
    // Checked before opening the transaction: it needs nothing from the database.
    const today = this.today();
    if (dto.effectiveFrom > today) {
      throw new BadRequestException({
        statusCode: 400,
        code: SALARY_REVISION_FUTURE_DATE,
        message:
          `A salary revision cannot take effect in the future (${dto.effectiveFrom}). The new ` +
          'pay is applied to the employee as soon as it is recorded, so payroll would pay it ' +
          'before its date. Record the revision on or after the day it takes effect.',
      });
    }

    const { revision, companyId, changed } = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        const employee = await tx.employee.findFirst({
          where: { id: employeeId },
          select: {
            companyId: true,
            basic: true,
            hra: true,
            conveyanceAllowance: true,
            siteAllowance: true,
            specialAllowance: true,
          },
        });
        if (!employee) throw new NotFoundException('Employee not found');

        const latest = await tx.salaryRevision.findFirst({
          where: { employeeId },
          orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
          select: { effectiveFrom: true },
        });
        // `effectiveFrom` is `@db.Date`, read back as UTC midnight — so its ISO date part is
        // the stored calendar date, and a string comparison is the date comparison.
        const latestDate = latest?.effectiveFrom.toISOString().slice(0, 10);
        if (latestDate && dto.effectiveFrom < latestDate) {
          throw new BadRequestException({
            statusCode: 400,
            code: SALARY_REVISION_BEFORE_LATEST,
            message:
              `This employee's latest salary revision takes effect on ${latestDate}. A new ` +
              `revision cannot take effect before it (${dto.effectiveFrom}).`,
          });
        }

        const previous = headsOfEmployee(employee);
        const next = { ...previous } as Heads;
        for (const head of HEADS) {
          const value = dto[head];
          if (value !== undefined) next[head] = new Prisma.Decimal(value);
        }

        const recorded = await this.recordInTx(tx, {
          companyId: employee.companyId,
          employeeId,
          effectiveFrom: dto.effectiveFrom,
          previous,
          next,
          remarks: dto.remarks ?? null,
          createdByUserId: caller.userId,
        });
        if (!recorded) {
          throw new BadRequestException({
            statusCode: 400,
            code: SALARY_REVISION_NO_CHANGE,
            message:
              'None of the salary heads differ from what this employee is paid now, so there ' +
              'is nothing to revise.',
          });
        }
        const { revision, changed } = recorded;

        await tx.employee.update({
          where: { id: employeeId },
          data: employeeColumnsOf(next),
        });

        return { revision, companyId: employee.companyId, changed };
      },
    );

    // As `EmployeesService.update` does: the changed field names, not the values. The figures
    // live on the revision row, which the id below points at.
    await this.auditLog.record({
      entityType: AuditEntityType.EMPLOYEE,
      action: AuditAction.UPDATE,
      entityId: employeeId,
      changes: {
        fields: changed.map((head) =>
          head === 'conveyance' ? 'conveyanceAllowance' : head,
        ),
        salaryRevisionId: revision.id,
        effectiveFrom: dto.effectiveFrom,
      },
      accountId: caller.userId,
      companyId,
      ipAddress: caller.ipAddress,
    });

    return toView(revision);
  }
}

function amountOf(value: Prisma.Decimal | null): Prisma.Decimal {
  return value ?? new Prisma.Decimal(0);
}

function grossOf(heads: (Prisma.Decimal | null)[]): number {
  return heads
    .reduce<Prisma.Decimal>(
      (sum, head) => sum.plus(amountOf(head)),
      new Prisma.Decimal(0),
    )
    .toNumber();
}

function toView(row: SalaryRevision): SalaryRevisionView {
  return {
    ...row,
    previousGross: grossOf([
      row.previousBasic,
      row.previousHra,
      row.previousConveyance,
      row.previousSiteAllowance,
      row.previousSpecialAllowance,
    ]),
    gross: grossOf([
      row.basic,
      row.hra,
      row.conveyance,
      row.siteAllowance,
      row.specialAllowance,
    ]),
  };
}
