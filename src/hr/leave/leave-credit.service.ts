import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  LeaveCreditMode,
  LeaveLedgerKind,
  LeaveTypeCode,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { SettingsConfig } from '../../common/configs/config.interface';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../biometrics/face-enrolment.service';
import { financialYearOf, zonedDateOnly } from './leave-days';

/** The leave types that carry a balance — leave without pay is never credited. */
export const CREDITED_LEAVE_TYPES = [
  LeaveTypeCode.earned,
  LeaveTypeCode.casual,
  LeaveTypeCode.sick,
] as const;
export type CreditedLeaveType = (typeof CREDITED_LEAVE_TYPES)[number];

export interface LeavePolicyView {
  leaveType: CreditedLeaveType;
  annualDays: number;
  creditMode: LeaveCreditMode;
  carryForward: boolean;
  carryForwardCap: number | null;
  prorateJoiners: boolean;
  /** True when the company has not saved a policy and this row is the built-in default. */
  isDefault: boolean;
}

/**
 * The policy a company has until HR saves its own (2026-10-16: "create a screen with typical
 * defaults where HR can edit it").
 *
 * Typical for an Indian construction company's staff: earned leave accruing 1.5 days a month (18
 * a year) and carried forward up to 45 days; casual and sick leave granted for the year on 1 April
 * and lapsing at its end. Every figure is editable per company.
 */
export const DEFAULT_LEAVE_POLICY: Record<
  CreditedLeaveType,
  Omit<LeavePolicyView, 'leaveType' | 'isDefault'>
> = {
  earned: {
    annualDays: 18,
    creditMode: LeaveCreditMode.monthly,
    carryForward: true,
    carryForwardCap: 45,
    prorateJoiners: true,
  },
  casual: {
    annualDays: 8,
    creditMode: LeaveCreditMode.yearly,
    carryForward: false,
    carryForwardCap: null,
    prorateJoiners: true,
  },
  sick: {
    annualDays: 7,
    creditMode: LeaveCreditMode.yearly,
    carryForward: false,
    carryForwardCap: null,
    prorateJoiners: true,
  },
};

export interface CreditRunResult {
  employees: number;
  entries: number;
  days: number;
}

/** Two decimals, as the balance columns store. */
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Half days — a prorated yearly grant of 4.67 days is 4.5, the way HR would write it. */
const toHalf = (n: number) => Math.round(n * 2) / 2;

/** `YYYY-MM` months of financial year `fy` from April through `throughMonth`, inclusive. */
function monthsOfYear(
  fy: string,
  from: string,
  throughMonth: string,
): string[] {
  const start = Number(fy.slice(0, 4));
  const months: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const year = i < 9 ? start : start + 1;
    const month = `${year}-${String(((i + 3) % 12) + 1).padStart(2, '0')}`;
    if (month >= from && month <= throughMonth) months.push(month);
  }
  return months;
}

function previousYear(fy: string): string {
  const start = Number(fy.slice(0, 4)) - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Leave entitlement: the policy, the crediting, and HR's corrections (2026-10-16).
 *
 * Before this nothing wrote a balance's opening or accrued figure, so every employee held zero
 * earned, casual and sick leave and could apply only for leave without pay. Now:
 *
 * - **Monthly** types are credited a twelfth of the year on the first of each month, from April or
 *   the month the employee joined.
 * - **Yearly** types are credited whole on 1 April — scaled to the months remaining for someone who
 *   joins mid-year, when the policy prorates.
 * - **Carry-forward** moves last year's unused days, up to the cap, into this year's opening.
 * - **Adjustments** let HR add or take away days for one person, with a reason.
 * - **Import** sets opening balances once, at go-live, so nobody starts at zero.
 *
 * Every change is a `LeaveLedgerEntry`, and its unique key is what makes crediting safe to run as
 * often as anyone likes: the daily job and HR's "credit now" button can both run, and a month is
 * still credited once. A run also catches up — switched on in October, it credits April onwards.
 */
@Injectable()
export class LeaveCreditService {
  private readonly logger = new Logger(LeaveCreditService.name);
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
  }

  today(): string {
    return zonedDateOnly(new Date(), this.timeZone);
  }

  // ── Policy ─────────────────────────────────────────────────────────────────

  async getPolicy(
    ctx: RlsContext,
    companyId: string,
  ): Promise<LeavePolicyView[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.leavePolicy.findMany({ where: { companyId } }),
    );
    const byType = new Map(rows.map((row) => [row.leaveType, row]));
    return CREDITED_LEAVE_TYPES.map((leaveType) => {
      const row = byType.get(leaveType);
      if (!row) {
        return {
          leaveType,
          ...DEFAULT_LEAVE_POLICY[leaveType],
          isDefault: true,
        };
      }
      return {
        leaveType,
        annualDays: row.annualDays.toNumber(),
        creditMode: row.creditMode,
        carryForward: row.carryForward,
        carryForwardCap: row.carryForwardCap?.toNumber() ?? null,
        prorateJoiners: row.prorateJoiners,
        isDefault: false,
      };
    });
  }

  async setPolicy(
    caller: Caller,
    companyId: string,
    rows: Omit<LeavePolicyView, 'isDefault'>[],
  ): Promise<LeavePolicyView[]> {
    for (const row of rows) {
      if (!CREDITED_LEAVE_TYPES.includes(row.leaveType)) {
        throw new BadRequestException(
          `${row.leaveType} leave is not credited.`,
        );
      }
      if (row.annualDays < 0 || row.annualDays > 365) {
        throw new BadRequestException('Days a year must be between 0 and 365.');
      }
    }
    await withRlsContext(this.prisma, caller.rls, async (tx) => {
      for (const row of rows) {
        const data = {
          annualDays: new Prisma.Decimal(row.annualDays),
          creditMode: row.creditMode,
          carryForward: row.carryForward,
          carryForwardCap:
            row.carryForward && row.carryForwardCap !== null
              ? new Prisma.Decimal(row.carryForwardCap)
              : null,
          prorateJoiners: row.prorateJoiners,
          updatedByUserId: caller.userId,
        };
        await tx.leavePolicy.upsert({
          where: {
            companyId_leaveType: { companyId, leaveType: row.leaveType },
          },
          create: { companyId, leaveType: row.leaveType, ...data },
          update: data,
        });
      }
    });
    await this.auditLog.record({
      entityType: AuditEntityType.LEAVE_APPLICATION,
      action: AuditAction.UPDATE,
      entityId: `leave-policy:${companyId}`,
      changes: { leavePolicy: rows } as unknown as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId,
      ipAddress: caller.ipAddress,
    });
    return this.getPolicy(caller.rls, companyId);
  }

  // ── Crediting ──────────────────────────────────────────────────────────────

  /**
   * Credits everything due to `companyId`'s active employees up to `today`: carry-forward into this
   * year, the yearly grants, and each month's accrual so far. Idempotent — see the class note.
   */
  async runCredits(
    ctx: RlsContext,
    companyId: string,
    today: string = this.today(),
  ): Promise<CreditRunResult> {
    const fy = financialYearOf(new Date(`${today}T00:00:00Z`));
    const prevFy = previousYear(fy);
    const fyStartMonth = `${fy.slice(0, 4)}-04`;
    const thisMonth = today.slice(0, 7);
    const policy = await this.getPolicy(ctx, companyId);

    const { employees, existing, previousBalances } = await withRlsContext(
      this.prisma,
      ctx,
      async (tx) => {
        const employees = await tx.employee.findMany({
          where: { companyId, isActive: true },
          select: { id: true, dateOfJoining: true },
        });
        const ids = employees.map((e) => e.id);
        const existing = await tx.leaveLedgerEntry.findMany({
          where: { companyId, financialYear: fy, employeeId: { in: ids } },
          select: {
            employeeId: true,
            leaveType: true,
            kind: true,
            period: true,
          },
        });
        const previousBalances = await tx.leaveBalance.findMany({
          where: { employeeId: { in: ids }, financialYear: prevFy },
        });
        return { employees, existing, previousBalances };
      },
    );

    const have = new Set(
      existing.map(
        (e) => `${e.employeeId}|${e.leaveType}|${e.kind}|${e.period}`,
      ),
    );
    const prevBalance = new Map(
      previousBalances.map((b) => [
        `${b.employeeId}|${b.leaveType}`,
        b.opening.toNumber() + b.accrued.toNumber() - b.used.toNumber(),
      ]),
    );

    type Pending = {
      employeeId: string;
      leaveType: CreditedLeaveType;
      kind: LeaveLedgerKind;
      period: string;
      days: number;
      /** Carry-forward and import land in opening; credits in accrued. */
      column: 'opening' | 'accrued';
    };
    const pending: Pending[] = [];

    for (const employee of employees) {
      const joined = employee.dateOfJoining
        ? employee.dateOfJoining.toISOString().slice(0, 10)
        : null;
      if (joined && joined > today) continue; // not joined yet
      const joinedMonth = joined ? joined.slice(0, 7) : null;
      const firstMonth =
        joinedMonth && joinedMonth > fyStartMonth ? joinedMonth : fyStartMonth;

      for (const rule of policy) {
        const key = (kind: LeaveLedgerKind, period: string) =>
          `${employee.id}|${rule.leaveType}|${kind}|${period}`;

        // Carry-forward into this year — once, and never over an imported opening.
        if (
          rule.carryForward &&
          !have.has(key(LeaveLedgerKind.carry_forward, fy)) &&
          !have.has(key(LeaveLedgerKind.opening_import, fy))
        ) {
          const unused = prevBalance.get(`${employee.id}|${rule.leaveType}`);
          if (unused !== undefined && unused > 0) {
            const days = r2(
              rule.carryForwardCap === null
                ? unused
                : Math.min(unused, rule.carryForwardCap),
            );
            pending.push({
              employeeId: employee.id,
              leaveType: rule.leaveType,
              kind: LeaveLedgerKind.carry_forward,
              period: fy,
              days,
              column: 'opening',
            });
          }
        }

        if (rule.annualDays <= 0) continue;

        if (rule.creditMode === LeaveCreditMode.yearly) {
          if (have.has(key(LeaveLedgerKind.yearly_credit, fy))) continue;
          const monthsLeft = monthsOfYear(
            fy,
            firstMonth,
            `${Number(fy.slice(0, 4)) + 1}-03`,
          ).length;
          const days =
            rule.prorateJoiners && monthsLeft < 12
              ? toHalf((rule.annualDays * monthsLeft) / 12)
              : rule.annualDays;
          if (days > 0) {
            pending.push({
              employeeId: employee.id,
              leaveType: rule.leaveType,
              kind: LeaveLedgerKind.yearly_credit,
              period: fy,
              days,
              column: 'accrued',
            });
          }
        } else {
          const perMonth = r2(rule.annualDays / 12);
          for (const month of monthsOfYear(fy, firstMonth, thisMonth)) {
            if (have.has(key(LeaveLedgerKind.monthly_credit, month))) continue;
            pending.push({
              employeeId: employee.id,
              leaveType: rule.leaveType,
              kind: LeaveLedgerKind.monthly_credit,
              period: month,
              days: perMonth,
              column: 'accrued',
            });
          }
        }
      }
    }

    let entries = 0;
    let days = 0;
    for (const item of pending) {
      try {
        await withRlsContext(this.prisma, ctx, async (tx) => {
          await tx.leaveLedgerEntry.create({
            data: {
              companyId,
              employeeId: item.employeeId,
              leaveType: item.leaveType,
              financialYear: fy,
              kind: item.kind,
              period: item.period,
              days: new Prisma.Decimal(item.days),
            },
          });
          await this.addToBalance(
            tx,
            item.employeeId,
            item.leaveType,
            fy,
            item.column,
            item.days,
          );
        });
        entries += 1;
        days += item.days;
      } catch (err) {
        // Another run got there first: the unique key did its job.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue;
        }
        throw err;
      }
    }

    return {
      employees: new Set(pending.map((p) => p.employeeId)).size,
      entries,
      days: r2(days),
    };
  }

  /** Every active company, for the daily job. */
  async runAllCompanies(): Promise<void> {
    const ctx: RlsContext = { isSuperAdmin: true };
    const companies = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.company.findMany({
        where: { status: 'active' },
        select: { id: true, name: true },
      }),
    );
    for (const company of companies) {
      try {
        const result = await this.runCredits(ctx, company.id);
        if (result.entries > 0) {
          this.logger.log(
            `Leave credited for ${company.name}: ${result.entries} entries, ${result.days} days, ${result.employees} employees`,
          );
        }
      } catch (err) {
        // One company's failure must not stop the rest being credited.
        this.logger.error(
          `Leave crediting failed for ${company.name}: ${
            (err as Error).message
          }`,
        );
      }
    }
  }

  // ── Adjustments ────────────────────────────────────────────────────────────

  /** HR adds or takes away days for one employee, with a reason (2026-10-16). */
  async adjust(
    caller: Caller,
    companyId: string,
    input: {
      employeeId: string;
      leaveType: CreditedLeaveType;
      financialYear: string;
      days: number;
      reason: string;
    },
  ) {
    if (!input.days)
      throw new BadRequestException('Enter the days to add or take away.');
    if (!input.reason.trim())
      throw new BadRequestException('A reason is required.');
    const days = r2(input.days);

    await withRlsContext(this.prisma, caller.rls, async (tx) => {
      const employee = await tx.employee.findFirst({
        where: { id: input.employeeId, companyId },
        select: { id: true },
      });
      if (!employee) throw new NotFoundException('Employee not found');

      const balance = await tx.leaveBalance.findUnique({
        where: {
          employeeId_leaveType_financialYear: {
            employeeId: input.employeeId,
            leaveType: input.leaveType,
            financialYear: input.financialYear,
          },
        },
      });
      const current = balance
        ? balance.opening.toNumber() +
          balance.accrued.toNumber() -
          balance.used.toNumber()
        : 0;
      if (current + days < 0) {
        throw new BadRequestException(
          `That would leave a negative balance: only ${r2(
            current,
          )} day(s) are available.`,
        );
      }

      await tx.leaveLedgerEntry.create({
        data: {
          companyId,
          employeeId: input.employeeId,
          leaveType: input.leaveType,
          financialYear: input.financialYear,
          kind: LeaveLedgerKind.adjustment,
          period: randomUUID(),
          days: new Prisma.Decimal(days),
          reason: input.reason.trim(),
          createdByUserId: caller.userId,
        },
      });
      await this.addToBalance(
        tx,
        input.employeeId,
        input.leaveType,
        input.financialYear,
        'accrued',
        days,
      );
    });

    await this.auditLog.record({
      entityType: AuditEntityType.LEAVE_APPLICATION,
      action: AuditAction.UPDATE,
      entityId: `leave-balance:${input.employeeId}`,
      changes: {
        adjustment: { ...input, days },
      } as unknown as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId,
      ipAddress: caller.ipAddress,
    });
    return { ok: true };
  }

  // ── Go-live import ─────────────────────────────────────────────────────────

  /**
   * Sets opening balances from HR's sheet, once, at go-live. Setting, not adding: re-importing a
   * corrected sheet replaces the earlier figure rather than doubling it. Rows naming an unknown
   * employee code are reported back, not silently skipped.
   */
  async importOpening(
    caller: Caller,
    companyId: string,
    financialYear: string,
    rows: {
      employeeCode: string;
      leaveType: CreditedLeaveType;
      opening: number;
    }[],
  ): Promise<{ applied: number; unknownCodes: string[] }> {
    const codes = [...new Set(rows.map((r) => r.employeeCode.trim()))];
    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: { companyId, employeeCode: { in: codes } },
        select: { id: true, employeeCode: true },
      }),
    );
    const byCode = new Map(employees.map((e) => [e.employeeCode, e.id]));
    const unknownCodes = codes.filter((code) => !byCode.has(code));

    let applied = 0;
    await withRlsContext(this.prisma, caller.rls, async (tx) => {
      for (const row of rows) {
        const employeeId = byCode.get(row.employeeCode.trim());
        if (!employeeId || row.opening < 0) continue;
        const opening = r2(row.opening);
        await tx.leaveBalance.upsert({
          where: {
            employeeId_leaveType_financialYear: {
              employeeId,
              leaveType: row.leaveType,
              financialYear,
            },
          },
          create: {
            employeeId,
            leaveType: row.leaveType,
            financialYear,
            opening: new Prisma.Decimal(opening),
          },
          update: { opening: new Prisma.Decimal(opening) },
        });
        await tx.leaveLedgerEntry.upsert({
          where: {
            employeeId_leaveType_financialYear_kind_period: {
              employeeId,
              leaveType: row.leaveType,
              financialYear,
              kind: LeaveLedgerKind.opening_import,
              period: financialYear,
            },
          },
          create: {
            companyId,
            employeeId,
            leaveType: row.leaveType,
            financialYear,
            kind: LeaveLedgerKind.opening_import,
            period: financialYear,
            days: new Prisma.Decimal(opening),
            reason: 'Opening balance import',
            createdByUserId: caller.userId,
          },
          update: {
            days: new Prisma.Decimal(opening),
            createdByUserId: caller.userId,
          },
        });
        applied += 1;
      }
    });

    await this.auditLog.record({
      entityType: AuditEntityType.LEAVE_APPLICATION,
      action: AuditAction.CREATE,
      entityId: `leave-opening-import:${companyId}:${financialYear}`,
      changes: { applied, unknownCodes } as unknown as Prisma.InputJsonValue,
      accountId: caller.userId,
      companyId,
      ipAddress: caller.ipAddress,
    });
    return { applied, unknownCodes };
  }

  /** Active employees with their current balances, for the import template. */
  async templateRows(
    ctx: RlsContext,
    companyId: string,
    financialYear: string,
  ) {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const employees = await tx.employee.findMany({
        where: { companyId, isActive: true },
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
        },
        orderBy: { employeeCode: 'asc' },
      });
      const balances = await tx.leaveBalance.findMany({
        where: {
          employeeId: { in: employees.map((e) => e.id) },
          financialYear,
        },
      });
      const opening = new Map(
        balances.map((b) => [
          `${b.employeeId}|${b.leaveType}`,
          b.opening.toNumber(),
        ]),
      );
      return employees.map((e) => ({
        employeeCode: e.employeeCode,
        name: [e.firstName, e.lastName].filter(Boolean).join(' '),
        earned: opening.get(`${e.id}|earned`) ?? 0,
        casual: opening.get(`${e.id}|casual`) ?? 0,
        sick: opening.get(`${e.id}|sick`) ?? 0,
      }));
    });
  }

  // ── History ────────────────────────────────────────────────────────────────

  async ledger(
    ctx: RlsContext,
    companyId: string,
    employeeId: string,
    financialYear: string,
  ) {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.leaveLedgerEntry.findMany({
        where: { companyId, employeeId, financialYear },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      leaveType: row.leaveType,
      kind: row.kind,
      period: row.kind === LeaveLedgerKind.adjustment ? null : row.period,
      days: row.days.toNumber(),
      reason: row.reason,
      byUser: row.createdByUserId !== null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async addToBalance(
    tx: Prisma.TransactionClient,
    employeeId: string,
    leaveType: LeaveTypeCode,
    financialYear: string,
    column: 'opening' | 'accrued',
    days: number,
  ) {
    const amount = new Prisma.Decimal(days);
    await tx.leaveBalance.upsert({
      where: {
        employeeId_leaveType_financialYear: {
          employeeId,
          leaveType,
          financialYear,
        },
      },
      create: { employeeId, leaveType, financialYear, [column]: amount },
      update: { [column]: { increment: amount } },
    });
  }
}
