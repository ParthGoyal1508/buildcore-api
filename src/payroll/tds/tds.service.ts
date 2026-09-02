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
  TaxDeclarationStatus,
  TaxRegime,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import type { HrPayrollConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../../hr/biometrics/face-enrolment.service';
import {
  capDeclaration,
  computeTds,
  financialYearOf,
  remainingMonthsInFy,
  validateSlabs,
  type TaxSlabBand,
} from './tds-computation';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Tax slabs, investment declarations and the TDS calculation (005 amendment US14).
 *
 * The arithmetic lives in `tds-computation.ts`; this service configures it and
 * feeds it real data.
 */
@Injectable()
export class TdsService {
  private readonly hrPayroll: HrPayrollConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.hrPayroll = configService.get<HrPayrollConfig>('hrPayroll');
  }

  // ── Slabs (FR-050) ─────────────────────────────────────────────────────────

  /**
   * Replaces a financial year's slab set for a regime.
   *
   * Replace rather than append: a slab set is only meaningful as a whole, and
   * editing one band at a time would let a set sit in a gapped or overlapping
   * state between requests — states this validates against precisely because
   * income would fall through them.
   */
  async setSlabs(
    caller: Caller,
    companyId: string,
    financialYear: string,
    regime: TaxRegime,
    bands: TaxSlabBand[],
  ) {
    const problem = validateSlabs(bands);
    if (problem) throw new BadRequestException(problem);

    await withRlsContext(this.prisma, caller.rls, async (tx) => {
      await tx.taxSlab.deleteMany({
        where: { companyId, financialYear, regime },
      });
      await tx.taxSlab.createMany({
        data: bands.map((b) => ({
          companyId,
          financialYear,
          regime,
          lowerBound: b.lowerBound,
          upperBound: b.upperBound,
          ratePercent: b.ratePercent,
        })),
      });
    });

    await this.auditLog.record({
      entityType: AuditEntityType.COMPANY,
      action: AuditAction.UPDATE,
      entityId: companyId,
      changes: { taxSlabs: { financialYear, regime, bands: bands.length } },
      accountId: caller.userId,
      companyId,
      ipAddress: caller.ipAddress,
    });

    return this.getSlabs(caller, companyId, financialYear, regime);
  }

  async getSlabs(
    caller: Caller,
    companyId: string,
    financialYear: string,
    regime: TaxRegime,
  ): Promise<TaxSlabBand[]> {
    const rows = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.taxSlab.findMany({
        where: { companyId, financialYear, regime },
        orderBy: { lowerBound: 'asc' },
      }),
    );
    return rows.map((r) => ({
      lowerBound: r.lowerBound.toNumber(),
      upperBound: r.upperBound ? r.upperBound.toNumber() : null,
      ratePercent: r.ratePercent.toNumber(),
    }));
  }

  // ── Declarations (FR-052) ──────────────────────────────────────────────────

  /**
   * Records an employee's declaration, capping each line at its section ceiling.
   *
   * The declared figure is stored alongside the capped one so the employee can see
   * that their claim was limited rather than quietly reduced.
   */
  async declare(
    caller: Caller,
    employeeId: string,
    financialYear: string,
    regime: TaxRegime,
    lines: { sectionCode: string; declaredAmount: number; proofRef?: string }[],
  ) {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: employeeId },
        select: { id: true, companyId: true },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');

    const ceilings = this.hrPayroll.statutory.tds.sectionCeilings;

    const declaration = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        const d = await tx.taxDeclaration.upsert({
          where: { employeeId_financialYear: { employeeId, financialYear } },
          create: { employeeId, financialYear, regime },
          update: { regime },
        });

        await tx.taxDeclarationLine.deleteMany({
          where: { declarationId: d.id },
        });
        await tx.taxDeclarationLine.createMany({
          data: lines.map((l) => ({
            declarationId: d.id,
            sectionCode: l.sectionCode.trim().toUpperCase(),
            declaredAmount: l.declaredAmount,
            cappedAmount: capDeclaration(
              l.sectionCode.trim().toUpperCase(),
              l.declaredAmount,
              ceilings,
            ),
            proofRef: l.proofRef ?? null,
          })),
        });

        return tx.taxDeclaration.findUniqueOrThrow({
          where: { id: d.id },
          include: { lines: true },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.TAX_DECLARATION,
      action: AuditAction.CREATE,
      entityId: declaration.id,
      changes: { financialYear, regime, lines: lines.length },
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    return this.toDeclarationView(declaration);
  }

  /** Marks one declaration line verified against submitted proof. */
  async verifyLine(caller: Caller, lineId: string) {
    const line = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.taxDeclarationLine.findFirst({ where: { id: lineId } }),
    );
    if (!line) throw new NotFoundException('Declaration line not found');
    if (!line.proofRef) {
      throw new BadRequestException(
        'That line has no proof attached; it cannot be verified.',
      );
    }

    return withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.taxDeclarationLine.update({
        where: { id: lineId },
        data: {
          status: TaxDeclarationStatus.verified,
          verifiedByUserId: caller.userId,
          verifiedAt: new Date(),
        },
      }),
    );
  }

  async getDeclaration(
    caller: Caller,
    employeeId: string,
    financialYear: string,
  ) {
    const d = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.taxDeclaration.findFirst({
        where: { employeeId, financialYear },
        include: { lines: true },
      }),
    );
    return d ? this.toDeclarationView(d) : null;
  }

  // ── Calculation (FR-051, FR-053) ───────────────────────────────────────────

  /**
   * This month's TDS for one employee.
   *
   * Called by the payroll engine during generation. Returns zero rather than
   * throwing when a company has not configured slabs: an unconfigured tax setup
   * should stall payroll visibly through the exception list, not by failing the
   * whole run for everyone.
   */
  async computeForEmployee(
    caller: Caller,
    employee: {
      id: string;
      companyId: string;
      panEncrypted: string | null;
    },
    period: string,
    currentMonthGross: number,
  ): Promise<{ tds: number; noPanRateApplied: boolean; slabsMissing: boolean }> {
    const [yearStr, monthStr] = period.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const financialYear = financialYearOf(year, month);

    const declaration = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.taxDeclaration.findFirst({
        where: { employeeId: employee.id, financialYear },
        include: { lines: true },
      }),
    );
    const regime = declaration?.regime ?? TaxRegime.new;

    const slabs = await this.getSlabs(
      caller,
      employee.companyId,
      financialYear,
      regime,
    );
    if (slabs.length === 0) {
      return { tds: 0, noPanRateApplied: false, slabsMissing: true };
    }

    // Past the cut-off month, only verified declarations count (FR-052).
    const cutOff = this.hrPayroll.statutory.tds.proofCutOffMonth;
    const pastCutOff = this.isPastCutOff(month, cutOff);
    const countable = (declaration?.lines ?? []).filter(
      (l) => !pastCutOff || l.status === TaxDeclarationStatus.verified,
    );
    const totalDeductions = r2(
      countable.reduce((a, l) => a + l.cappedAmount.toNumber(), 0),
    );

    const ytd = await this.yearToDate(caller, employee.id, financialYear);

    const result = computeTds(
      {
        earnedToDate: ytd.earned,
        currentMonthGross,
        remainingMonths: remainingMonthsInFy(month),
        deductedToDate: ytd.deducted,
        totalDeductions,
        standardDeduction: this.hrPayroll.statutory.tds.standardDeduction,
        hasPan: employee.panEncrypted !== null,
        noPanRatePercent: this.hrPayroll.statutory.tds.noPanRatePercent,
      },
      slabs,
    );

    return {
      tds: result.monthlyTds,
      noPanRateApplied: result.noPanRateApplied,
      slabsMissing: false,
    };
  }

  /** Quarterly TDS return data (FR-053, TA010). */
  async quarterlyReturn(
    caller: Caller,
    companyId: string,
    financialYear: string,
    quarter: 1 | 2 | 3 | 4,
  ) {
    const periods = this.periodsForQuarter(financialYear, quarter);

    const runs = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollRun.findMany({
        where: {
          companyId,
          period: { in: periods },
          status: { in: ['processed', 'paid'] },
        },
        include: { lineItems: true },
      }),
    );

    const employeeIds = [
      ...new Set(runs.flatMap((r) => r.lineItems.map((l) => l.employeeId))),
    ];
    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({ where: { id: { in: employeeIds } } }),
    );
    const byId = new Map(employees.map((e) => [e.id, e]));

    const rows = employeeIds.map((id) => {
      const e = byId.get(id);
      const lines = runs.flatMap((r) =>
        r.lineItems.filter((l) => l.employeeId === id),
      );
      const taxable = r2(
        lines.reduce(
          (a, l) =>
            a +
            l.basic.toNumber() +
            l.hra.toNumber() +
            l.conveyanceAllowance.toNumber() +
            l.siteAllowance.toNumber() +
            l.specialAllowance.toNumber() +
            l.otWages.toNumber(),
          0,
        ),
      );
      return {
        employeeCode: e?.employeeCode ?? id,
        name: [e?.firstName, e?.lastName].filter(Boolean).join(' ').trim(),
        // PAN is regulated PII: the return needs to show *whether* one is on file,
        // not what it is. The filing itself pulls the real value through the
        // audited reveal path.
        hasPan: e?.panEncrypted != null,
        taxableIncome: taxable,
        tdsDeducted: r2(lines.reduce((a, l) => a + l.tds.toNumber(), 0)),
      };
    });

    return {
      financialYear,
      quarter,
      periods,
      rows,
      totals: {
        taxableIncome: r2(rows.reduce((a, r) => a + r.taxableIncome, 0)),
        tdsDeducted: r2(rows.reduce((a, r) => a + r.tdsDeducted, 0)),
      },
      missingPan: rows.filter((r) => !r.hasPan).map((r) => r.employeeCode),
    };
  }

  /** Form 16 source data for one employee and year. */
  async formSixteenData(
    caller: Caller,
    employeeId: string,
    financialYear: string,
  ) {
    const ytd = await this.yearToDate(caller, employeeId, financialYear);
    const declaration = await this.getDeclaration(
      caller,
      employeeId,
      financialYear,
    );
    const deductions = r2(
      (declaration?.lines ?? []).reduce((a, l) => a + l.cappedAmount, 0),
    );
    const standardDeduction = this.hrPayroll.statutory.tds.standardDeduction;

    return {
      employeeId,
      financialYear,
      grossSalary: ytd.earned,
      standardDeduction,
      deductionsBySection: (declaration?.lines ?? []).map((l) => ({
        sectionCode: l.sectionCode,
        declaredAmount: l.declaredAmount,
        allowedAmount: l.cappedAmount,
        verified: l.status === TaxDeclarationStatus.verified,
      })),
      taxableIncome: r2(
        Math.max(ytd.earned - standardDeduction - deductions, 0),
      ),
      taxDeducted: ytd.deducted,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Taxable salary paid and TDS deducted so far in the financial year. */
  private async yearToDate(
    caller: Caller,
    employeeId: string,
    financialYear: string,
  ): Promise<{ earned: number; deducted: number }> {
    const periods = this.periodsForFy(financialYear);
    const lines = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.payrollLineItem.findMany({
        where: {
          employeeId,
          payrollRun: {
            period: { in: periods },
            status: { in: ['processed', 'paid'] },
          },
        },
      }),
    );

    return {
      earned: r2(
        lines.reduce(
          (a, l) =>
            a +
            l.basic.toNumber() +
            l.hra.toNumber() +
            l.conveyanceAllowance.toNumber() +
            l.siteAllowance.toNumber() +
            l.specialAllowance.toNumber() +
            l.otWages.toNumber(),
          0,
        ),
      ),
      deducted: r2(lines.reduce((a, l) => a + l.tds.toNumber(), 0)),
    };
  }

  /** Whether the current month is past the proof cut-off within the FY. */
  private isPastCutOff(month: number, cutOffMonth: number): boolean {
    const fyIndex = (m: number) => (m >= 4 ? m - 3 : m + 9);
    return fyIndex(month) > fyIndex(cutOffMonth);
  }

  /** The twelve `YYYY-MM` keys of an April–March financial year. */
  private periodsForFy(financialYear: string): string[] {
    const startYear = Number(financialYear.split('-')[0]);
    const periods: string[] = [];
    for (let i = 0; i < 12; i++) {
      const month = ((3 + i) % 12) + 1;
      const year = month >= 4 ? startYear : startYear + 1;
      periods.push(`${year}-${String(month).padStart(2, '0')}`);
    }
    return periods;
  }

  private periodsForQuarter(financialYear: string, quarter: number): string[] {
    return this.periodsForFy(financialYear).slice(
      (quarter - 1) * 3,
      quarter * 3,
    );
  }

  private toDeclarationView(d: {
    id: string;
    employeeId: string;
    financialYear: string;
    regime: TaxRegime;
    lines: {
      id: string;
      sectionCode: string;
      declaredAmount: Prisma.Decimal;
      cappedAmount: Prisma.Decimal;
      status: TaxDeclarationStatus;
      proofRef: string | null;
    }[];
  }) {
    return {
      id: d.id,
      employeeId: d.employeeId,
      financialYear: d.financialYear,
      regime: d.regime,
      lines: d.lines.map((l) => ({
        id: l.id,
        sectionCode: l.sectionCode,
        declaredAmount: l.declaredAmount.toNumber(),
        cappedAmount: l.cappedAmount.toNumber(),
        // Surfaced explicitly so an employee sees the cap rather than wondering
        // why their deduction shrank.
        wasCapped: l.cappedAmount.toNumber() < l.declaredAmount.toNumber(),
        status: l.status,
        hasProof: l.proofRef !== null,
      })),
    };
  }
}
