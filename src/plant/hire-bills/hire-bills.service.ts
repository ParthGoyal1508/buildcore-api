import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  EquipmentOwnership,
  HireBillBasis,
  HireBillStatus,
  MeterType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { businessToday } from '../../common/business-date';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { HireRatesService } from '../../settings/machinery-masters/hire-rates.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/plant.constants';
import { PlantRefsService } from '../plant-refs.service';
import {
  type FormFormat,
  type RenderedForm,
  fileSafe,
  renderFormFile,
} from '../../common/form-document';
import {
  CreateHireBillDto,
  ListHireBillsDto,
  PayHireBillDto,
  UpdateHireBillDto,
} from './dto/hire-bill.dto';
import { buildHireBillForm } from './hire-bill-document';

export interface HireBillRow {
  id: string;
  companyId: string;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  vendorId: string;
  vendorName: string;
  billedHours: number;
  rate: number;
  grossAmount: number;
  billingPeriodFrom: Date;
  billingPeriodTo: Date;
  /** What the logbook said when the bill was raised — a snapshot, not a live join. */
  logbookHours: number;
  /** `billedHours − logbookHours`. Positive means the vendor billed for more than
   * the machine ran. Never a block: verification is an admin decision. */
  variance: number;
  tdsRate: number | null;
  tdsAmount: number;
  netPayable: number;
  status: HireBillStatus;
  verifiedByUserId: string | null;
  verifiedAt: Date | null;
  paymentDate: Date | null;
  paymentReference: string | null;
  createdAt: Date;
  // ── The vehicle hiring bill (2026-10-15) ──
  basis: HireBillBasis;
  meterType: MeterType;
  registrationNo: string | null;
  hireOrderId: string | null;
  hireOrderCode: string | null;
  billDate: Date | null;
  invoiceNo: string | null;
  taxInvoiceRef: string | null;
  taxInvoiceDate: Date | null;
  description: string | null;
  periodDays: number | null;
  monthlyRate: number | null;
  agreedAverage: number | null;
  startReading: number | null;
  endReading: number | null;
  dieselGiven: number | null;
  actualDiesel: number | null;
  deductionAmount: number;
  holdAmount: number;
  /** Fuel recovered through a variance review (020), separate from the deduction above. */
  fuelRecoveryTotal: number;
}

const num = (value: Prisma.Decimal | null) =>
  value === null ? null : Number(value);

/** Litres the work should have taken at the agreed average — l/hr × hours, or km ÷ km/l. */
export function expectedDiesel(
  meterType: MeterType,
  run: number,
  average: number | null,
): number | null {
  if (!average || average <= 0) return null;
  const litres = meterType === MeterType.km ? run / average : run * average;
  return Math.round(litres * 1000) / 1000;
}

/** Rupees, rounded to paise. Money arithmetic done in floats and left unrounded is
 * how a bill ends up a paisa out from its own components. */
export function paise(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A monthly rent over the days billed (2026-10-15): the full rent for a whole month, pro-rated by
 * the days of the period's own month otherwise — 31 days of August at 1,50,000 is 1,50,000; 15
 * days is 72,580.65.
 */
export function monthlyGross(
  monthlyRate: number,
  periodDays: number,
  periodFrom: Date,
): number {
  const daysInMonth = new Date(
    Date.UTC(periodFrom.getUTCFullYear(), periodFrom.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return paise((monthlyRate * periodDays) / daysInMonth);
}

/**
 * Computes a hire bill's financial fields (FR-005, SC-003).
 *
 * Pulled out of the service so the arithmetic is testable without a database, and
 * so there is exactly one definition of `netPayable = grossAmount − tdsAmount`.
 */
export function computeHireBillAmounts(params: {
  billedHours: number;
  rate: number;
  tdsRate: number | null;
  /**
   * Fuel recovered from this bill (020 FR-004), every deduction currently against it.
   *
   * **A list, not a running total, and recomputed rather than decremented** (plan D28). A
   * `netPayable` reduced by an `UPDATE` is a number with no derivation: a vendor disputing the bill
   * is owed the arithmetic, and "it used to be more" is not arithmetic. Passing the deductions in
   * means `netPayable` is always a function of things that can be shown on the bill beside it.
   *
   * It also makes removal free. Reversing a deduction (FR-010) deletes its row and recomputes, where
   * an in-place decrement would need an inverse adjustment — a second entry explaining the first,
   * which is how a bill acquires a history nobody can read.
   */
  deductions?: readonly number[];
  /**
   * The gross of a monthly bill (2026-10-15), already pro-rated — given, it replaces
   * `billedHours × rate`, which on a monthly bill is a distance, not what is charged.
   */
  grossAmount?: number;
  /** The vehicle hiring bill's own "Deduction Amount" and "Debit / Hold Amount". */
  otherDeductions?: readonly number[];
}): {
  grossAmount: number;
  tdsAmount: number;
  deductionTotal: number;
  netPayable: number;
} {
  const grossAmount = paise(
    params.grossAmount ?? params.billedHours * params.rate,
  );
  const tdsAmount =
    params.tdsRate === null ? 0 : paise((grossAmount * params.tdsRate) / 100);
  const deductionTotal = paise(
    [...(params.deductions ?? []), ...(params.otherDeductions ?? [])].reduce(
      (sum, amount) => sum + amount,
      0,
    ),
  );
  return {
    grossAmount,
    tdsAmount,
    deductionTotal,
    netPayable: paise(grossAmount - tdsAmount - deductionTotal),
  };
}

/**
 * Hire bills (006 US7).
 *
 * A hire bill is a rental charge for a *hired* machine — distinct from a
 * `ServiceBill`, which is a third party's invoice for repairing an owned one
 * (FR-022). The two are never the same document and this service refuses to raise
 * one against owned equipment.
 *
 * The rate defaults from the effective-dated Hire Rate master rather than being
 * typed per bill (FR-014). That is what makes SC-006 hold: a bill for last March
 * resolves last March's rate, because the lookup is by the billing period's start
 * date rather than by "now".
 */
@Injectable()
export class HireBillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: PlantRefsService,
    private readonly hireRates: HireRatesService,
  ) {}

  private readonly include = {
    equipment: {
      select: { code: true, name: true, registrationNo: true, meterType: true },
    },
    hireOrder: { select: { code: true } },
    fuelDeductions: { select: { amount: true } },
  } as const;

  private toRow(
    row: Prisma.HireBillGetPayload<{
      include: {
        equipment: {
          select: {
            code: true;
            name: true;
            registrationNo: true;
            meterType: true;
          };
        };
        hireOrder: { select: { code: true } };
        fuelDeductions: { select: { amount: true } };
      };
    }>,
    vendorName: string,
  ): HireBillRow {
    return {
      basis: row.basis,
      meterType: row.equipment.meterType,
      registrationNo: row.equipment.registrationNo,
      hireOrderId: row.hireOrderId,
      hireOrderCode: row.hireOrder?.code ?? null,
      billDate: row.billDate,
      invoiceNo: row.invoiceNo,
      taxInvoiceRef: row.taxInvoiceRef,
      taxInvoiceDate: row.taxInvoiceDate,
      description: row.description,
      periodDays: row.periodDays,
      monthlyRate: num(row.monthlyRate),
      agreedAverage: num(row.agreedAverage),
      startReading: num(row.startReading),
      endReading: num(row.endReading),
      dieselGiven: num(row.dieselGiven),
      actualDiesel: num(row.actualDiesel),
      deductionAmount: Number(row.deductionAmount),
      holdAmount: Number(row.holdAmount),
      fuelRecoveryTotal: paise(
        row.fuelDeductions.reduce((sum, d) => sum + Number(d.amount), 0),
      ),
      id: row.id,
      companyId: row.companyId,
      equipmentId: row.equipmentId,
      equipmentCode: row.equipment.code,
      equipmentName: row.equipment.name,
      vendorId: row.vendorId,
      vendorName,
      billedHours: Number(row.billedHours),
      rate: Number(row.rate),
      grossAmount: Number(row.grossAmount),
      billingPeriodFrom: row.billingPeriodFrom,
      billingPeriodTo: row.billingPeriodTo,
      logbookHours: Number(row.logbookHours),
      variance: Number(row.variance),
      tdsRate: row.tdsRate === null ? null : Number(row.tdsRate),
      tdsAmount: Number(row.tdsAmount),
      netPayable: Number(row.netPayable),
      status: row.status,
      verifiedByUserId: row.verifiedByUserId,
      verifiedAt: row.verifiedAt,
      paymentDate: row.paymentDate,
      paymentReference: row.paymentReference,
      createdAt: row.createdAt,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListHireBillsDto,
  ): Promise<{
    items: HireBillRow[];
    total: number;
    page: number;
    pageSize: number;
    pendingVerificationCount: number;
    unpaidTotal: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.HireBillWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.equipmentId ? { equipmentId: query.equipmentId } : {}),
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const { rows, total, pending, unpaid } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total, pending, unpaid] = await Promise.all([
          tx.hireBill.findMany({
            where,
            orderBy: [{ billingPeriodFrom: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: this.include,
          }),
          tx.hireBill.count({ where }),
          tx.hireBill.count({
            where: {
              ...companyScope(caller, query.companyId),
              status: HireBillStatus.pending_verification,
            },
          }),
          tx.hireBill.aggregate({
            where: {
              ...companyScope(caller, query.companyId),
              status: { not: HireBillStatus.paid },
            },
            _sum: { netPayable: true },
          }),
        ]);
        return { rows, total, pending, unpaid };
      },
    );

    const vendorNames = await this.refs.vendorNames(
      caller,
      rows.map((row) => row.vendorId),
    );

    return {
      items: rows.map((row) =>
        this.toRow(row, vendorNames.get(row.vendorId) ?? 'Unknown vendor'),
      ),
      total,
      page,
      pageSize,
      pendingVerificationCount: pending,
      unpaidTotal: Number(unpaid._sum.netPayable ?? 0),
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateHireBillDto,
    ipAddress: string,
  ): Promise<HireBillRow> {
    const from = this.refs.parseDate(dto.billingPeriodFrom);
    const to = this.refs.parseDate(dto.billingPeriodTo);
    if (to < from) {
      throw new BadRequestException(
        'billingPeriodTo cannot be earlier than billingPeriodFrom.',
      );
    }
    const monthly = dto.basis === HireBillBasis.monthly;
    if (monthly && dto.monthlyRate === undefined) {
      throw new BadRequestException('A monthly bill needs the monthly rent.');
    }
    if (!monthly && dto.billedHours === undefined) {
      throw new BadRequestException('Give the hours (or km) billed.');
    }

    const vendorName = await this.refs.requireVendorName(caller, dto.vendorId);
    const tds = await this.refs.vendorTds(caller, dto.vendorId);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const equipment = await tx.equipment.findUnique({
          where: { id: dto.equipmentId },
        });
        if (!equipment) {
          throw new BadRequestException(
            `Equipment ${dto.equipmentId} does not exist.`,
          );
        }
        assertInScope(caller, equipment, 'Equipment');
        if (equipment.ownership === EquipmentOwnership.owned) {
          throw new BadRequestException(
            `${equipment.code} is owned, not hired — a repair invoice for an owned ` +
              'machine is a service bill, not a hire bill (FR-022).',
          );
        }
        // 036 K3: one bill per machine per day. The machine's row is locked first so two bills
        // raised at once for overlapping periods cannot both pass the check below; without it,
        // both were accepted and both could be verified and paid. Hire bills have no cancelled
        // state (nor a delete), so every existing bill counts.
        await tx.$queryRaw`
          SELECT "id" FROM "plant"."Equipment" WHERE "id" = ${dto.equipmentId} FOR UPDATE
        `;
        const overlapping = await tx.hireBill.findFirst({
          where: {
            equipmentId: dto.equipmentId,
            billingPeriodFrom: { lte: to },
            billingPeriodTo: { gte: from },
          },
          select: {
            invoiceNo: true,
            billingPeriodFrom: true,
            billingPeriodTo: true,
          },
        });
        if (overlapping) {
          throw new ConflictException(
            `${equipment.code} already has a hire bill${
              overlapping.invoiceNo ? ` (${overlapping.invoiceNo})` : ''
            } for ${isoDate(overlapping.billingPeriodFrom)} to ${isoDate(
              overlapping.billingPeriodTo,
            )}, which overlaps this period. A machine's hire is billed once for any day.`,
          );
        }

        if (dto.hireOrderId) {
          const order = await tx.hireOrder.findUnique({
            where: { id: dto.hireOrderId },
            select: { companyId: true, vendorId: true },
          });
          if (!order || order.companyId !== equipment.companyId) {
            throw new BadRequestException('Hire order not found.');
          }
          if (order.vendorId !== dto.vendorId) {
            throw new BadRequestException(
              'The hire order is with a different supplier.',
            );
          }
        }

        // A snapshot, not a live join (research.md §8): the bill must stay
        // verifiable against what the logbook said when it was raised, even if an
        // entry inside the period is corrected afterwards.
        const period = {
          equipmentId: dto.equipmentId,
          date: { gte: from, lte: to },
        };
        const [logbook, first, last, fuel] = await Promise.all([
          tx.logbookEntry.aggregate({
            where: period,
            _sum: { totalHours: true },
          }),
          tx.logbookEntry.findFirst({
            where: period,
            orderBy: { date: 'asc' },
            select: { openingReading: true },
          }),
          tx.logbookEntry.findFirst({
            where: period,
            orderBy: { date: 'desc' },
            select: { closingReading: true },
          }),
          tx.fuelEntry.aggregate({
            where: period,
            _sum: { quantity: true, amount: true },
          }),
        ]);
        const logbookHours = Number(logbook._sum.totalHours ?? 0);

        // The operating details: the readings over the period, the diesel the company supplied,
        // and what the run should have taken at the agreed average (2026-10-15).
        const startReading =
          dto.startReading ?? (first ? Number(first.openingReading) : null);
        const endReading =
          dto.endReading ?? (last ? Number(last.closingReading) : null);
        // 036 K8: refused rather than clamped. An end reading below the start one was silently
        // treated as zero run, which hid a typo behind a plausible-looking bill.
        if (
          startReading !== null &&
          endReading !== null &&
          endReading < startReading
        ) {
          throw new BadRequestException(
            `The end reading (${endReading}) is below the start reading (${startReading}).`,
          );
        }
        const run =
          startReading !== null && endReading !== null
            ? endReading - startReading
            : logbookHours;
        const category = await tx.equipmentCategory.findUnique({
          where: { id: equipment.categoryId },
          select: { fuelBenchmark: true },
        });
        const benchmark = num(category?.fuelBenchmark ?? null);
        const agreedAverage =
          dto.agreedAverage ??
          (benchmark && benchmark > 0
            ? equipment.meterType === MeterType.km
              ? Math.round((1 / benchmark) * 1000) / 1000
              : benchmark
            : null);
        const dieselGiven = Number(fuel._sum.quantity ?? 0);
        const deductionAmount =
          dto.deductionAmount ?? paise(Number(fuel._sum.amount ?? 0));
        const holdAmount = dto.holdAmount ?? 0;

        const days =
          Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
        const periodDays = dto.periodDays ?? days;
        const billedHours = dto.billedHours ?? run;

        let rate: number;
        let grossAmount: number | undefined;
        if (monthly) {
          rate = dto.monthlyRate!;
          grossAmount = monthlyGross(rate, periodDays, from);
        } else {
          // Resolved at the period's *start*, not today, so a bill raised late still
          // costs what the machine cost when it was working (SC-006).
          const resolved =
            dto.rate ??
            (await this.hireRates.getEffectiveHireRate(
              caller,
              equipment.categoryId,
              from,
            ));
          if (resolved === null || resolved === undefined) {
            throw new BadRequestException(
              'No hire rate is on file for this category on ' +
                `${dto.billingPeriodFrom.slice(
                  0,
                  10,
                )}. Add one under Machinery ` +
                'Masters, or supply a rate on the bill.',
            );
          }
          rate = resolved;
        }

        const amounts = computeHireBillAmounts({
          billedHours,
          rate,
          tdsRate: tds.tdsRate,
          grossAmount,
          otherDeductions: [deductionAmount, holdAmount],
        });
        assertNonNegativeNet(amounts.netPayable);

        return tx.hireBill.create({
          data: {
            companyId: equipment.companyId,
            equipmentId: dto.equipmentId,
            vendorId: dto.vendorId,
            billedHours,
            rate,
            grossAmount: amounts.grossAmount,
            billingPeriodFrom: from,
            billingPeriodTo: to,
            logbookHours,
            variance: Math.round((billedHours - logbookHours) * 1000) / 1000,
            tdsRate: tds.tdsRate,
            tdsAmount: amounts.tdsAmount,
            netPayable: amounts.netPayable,
            basis: dto.basis ?? HireBillBasis.hours,
            hireOrderId: dto.hireOrderId ?? null,
            billDate: dto.billDate
              ? this.refs.parseDate(dto.billDate)
              : this.refs.parseDate(new Date().toISOString()),
            invoiceNo: dto.invoiceNo?.trim() || null,
            taxInvoiceRef: dto.taxInvoiceRef?.trim() || null,
            taxInvoiceDate: dto.taxInvoiceDate
              ? this.refs.parseDate(dto.taxInvoiceDate)
              : null,
            description: dto.description?.trim() || null,
            periodDays,
            monthlyRate: monthly ? rate : null,
            agreedAverage,
            startReading,
            endReading,
            dieselGiven,
            actualDiesel: expectedDiesel(
              equipment.meterType,
              run,
              agreedAverage,
            ),
            deductionAmount,
            holdAmount,
            createdByUserId: caller.id,
          },
          include: this.include,
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.HIRE_BILL,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
      changes: {
        equipmentId: created.equipmentId,
        vendorId: created.vendorId,
        basis: created.basis,
        grossAmount: Number(created.grossAmount),
        netPayable: Number(created.netPayable),
      },
    });
    return this.toRow(created, vendorName);
  }

  /** Corrects an unverified bill's printed fields, deduction and hold, recomputing its net. */
  async update(
    caller: AuthenticatedUser,
    billId: string,
    dto: UpdateHireBillDto,
    ipAddress: string,
  ): Promise<HireBillRow> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.hireBill.findUnique({
          where: { id: billId },
          include: this.include,
        });
        if (!existing) throw new NotFoundException('Hire bill not found');
        assertInScope(caller, existing, 'Hire bill');
        if (existing.status !== HireBillStatus.pending_verification) {
          throw new ConflictException(
            'Only a bill awaiting verification can be corrected.',
          );
        }
        const deductionAmount =
          dto.deductionAmount ?? Number(existing.deductionAmount);
        const holdAmount = dto.holdAmount ?? Number(existing.holdAmount);
        const agreedAverage =
          dto.agreedAverage !== undefined
            ? dto.agreedAverage
            : num(existing.agreedAverage);
        const run =
          existing.startReading !== null && existing.endReading !== null
            ? Math.max(
                0,
                Number(existing.endReading) - Number(existing.startReading),
              )
            : Number(existing.logbookHours);
        const amounts = computeHireBillAmounts({
          billedHours: Number(existing.billedHours),
          rate: Number(existing.rate),
          tdsRate: num(existing.tdsRate),
          deductions: existing.fuelDeductions.map((d) => Number(d.amount)),
          ...(existing.basis === HireBillBasis.monthly
            ? { grossAmount: Number(existing.grossAmount) }
            : {}),
          otherDeductions: [deductionAmount, holdAmount],
        });
        assertNonNegativeNet(amounts.netPayable);
        const date = (value: string | undefined) =>
          value === undefined
            ? undefined
            : value
            ? this.refs.parseDate(value)
            : null;
        const text = (value: string | undefined) =>
          value === undefined ? undefined : value.trim() || null;
        return tx.hireBill.update({
          where: { id: billId },
          data: {
            billDate: date(dto.billDate),
            invoiceNo: text(dto.invoiceNo),
            taxInvoiceRef: text(dto.taxInvoiceRef),
            taxInvoiceDate: date(dto.taxInvoiceDate),
            description: text(dto.description),
            agreedAverage,
            actualDiesel: expectedDiesel(
              existing.equipment.meterType,
              run,
              agreedAverage,
            ),
            deductionAmount,
            holdAmount,
            netPayable: amounts.netPayable,
          },
          include: this.include,
        });
      },
    );
    await this.auditLog.record({
      entityType: AuditEntityType.HIRE_BILL,
      action: AuditAction.UPDATE,
      entityId: billId,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
      changes: JSON.parse(JSON.stringify(dto)) as Prisma.InputJsonObject,
    });
    const vendorName = await this.refs.requireVendorName(
      caller,
      updated.vendorId,
    );
    return this.toRow(updated, vendorName);
  }

  /** The bill in the client's VEHICLE HIRING BILL format — PDF, Excel or Word. */
  async document(
    caller: AuthenticatedUser,
    billId: string,
    format: FormFormat,
  ): Promise<RenderedForm> {
    const row = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const found = await tx.hireBill.findUnique({
          where: { id: billId },
          include: this.include,
        });
        if (!found) throw new NotFoundException('Hire bill not found');
        assertInScope(caller, found, 'Hire bill');
        return found;
      },
    );
    const [company, vendor] = await Promise.all([
      this.refs.documentCompany(row.companyId),
      this.refs.vendorParticulars(caller, row.vendorId),
    ]);
    const bill = this.toRow(row, vendor?.name ?? 'Unknown vendor');
    return renderFormFile(
      buildHireBillForm(bill, company, vendor),
      format,
      fileSafe(
        `Vehicle Hiring Bill ${
          bill.registrationNo ?? bill.equipmentCode
        } ${bill.billingPeriodFrom.toISOString().slice(0, 7)}`,
      ),
    );
  }

  async verify(
    caller: AuthenticatedUser,
    billId: string,
    ipAddress: string,
  ): Promise<HireBillRow> {
    const verified = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.hireBill.findUnique({
          where: { id: billId },
        });
        if (!existing) throw new NotFoundException('Hire bill not found');
        assertInScope(caller, existing, 'Hire bill');
        if (existing.status !== HireBillStatus.pending_verification) {
          throw new ConflictException(
            `This bill is already ${existing.status.replace('_', ' ')}.`,
          );
        }
        // Maker-checker (036 K8, decision 4: block, no override). Verifying is checking the
        // billed hours against the logbook; the person who typed them is the one person whose
        // check adds nothing. A bill from before the column with no audit entry to backfill it
        // from has no known creator, and stays verifiable by anyone.
        if (existing.createdByUserId === caller.id) {
          throw new ForbiddenException(
            'You raised this hire bill, so someone else must verify it.',
          );
        }
        return tx.hireBill.update({
          where: { id: billId },
          data: {
            status: HireBillStatus.verified,
            verifiedByUserId: caller.id,
            verifiedAt: new Date(),
          },
          include: this.include,
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.HIRE_BILL,
      action: AuditAction.UPDATE,
      entityId: billId,
      accountId: caller.id,
      companyId: verified.companyId,
      ipAddress,
      changes: {
        status: 'verified',
        variance: Number(verified.variance),
        netPayable: Number(verified.netPayable),
      },
    });

    const vendorName = await this.refs.requireVendorName(
      caller,
      verified.vendorId,
    );
    return this.toRow(verified, vendorName);
  }

  async pay(
    caller: AuthenticatedUser,
    billId: string,
    dto: PayHireBillDto,
    ipAddress: string,
  ): Promise<HireBillRow> {
    const paid = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.hireBill.findUnique({
          where: { id: billId },
        });
        if (!existing) throw new NotFoundException('Hire bill not found');
        assertInScope(caller, existing, 'Hire bill');
        if (existing.status === HireBillStatus.pending_verification) {
          throw new ConflictException(
            'This bill has not been verified yet. Verify the billed hours against ' +
              'the logbook before paying it.',
          );
        }
        if (existing.status === HireBillStatus.paid) {
          throw new ConflictException('This bill is already paid.');
        }
        return tx.hireBill.update({
          where: { id: billId },
          data: {
            status: HireBillStatus.paid,
            // Optional since 036 K8; omitted, it is today in the business timezone — the old
            // client sent "today" from the browser, and the server's UTC "today" would be
            // yesterday until 05:30 IST.
            paymentDate: dto.paymentDate
              ? this.refs.parseDate(dto.paymentDate)
              : businessToday(),
            paymentReference: dto.paymentReference.trim(),
          },
          include: this.include,
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.HIRE_BILL,
      action: AuditAction.UPDATE,
      entityId: billId,
      accountId: caller.id,
      companyId: paid.companyId,
      ipAddress,
      changes: {
        status: 'paid',
        paymentReference: dto.paymentReference,
        paymentDate: paid.paymentDate?.toISOString().slice(0, 10) ?? null,
      },
    });

    const vendorName = await this.refs.requireVendorName(caller, paid.vendorId);
    return this.toRow(paid, vendorName);
  }
}

/** `YYYY-MM-DD` of a date-only column, for messages. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Refuses a bill whose deductions exceed what it pays (036 K8). A negative net is not a bill — it
 * says the vendor owes the company — and it used to be saved, verified and "paid" as one.
 */
function assertNonNegativeNet(netPayable: number): void {
  if (netPayable < 0) {
    throw new BadRequestException(
      `The deductions exceed the bill: the net payable would be ${netPayable}. ` +
        'Reduce the deduction or hold amount, or recover the difference another way.',
    );
  }
}
