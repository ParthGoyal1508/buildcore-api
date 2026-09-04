import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  EquipmentOwnership,
  HireBillStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { HireRatesService } from '../../settings/machinery-masters/hire-rates.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/plant.constants';
import { PlantRefsService } from '../plant-refs.service';
import {
  CreateHireBillDto,
  ListHireBillsDto,
  PayHireBillDto,
} from './dto/hire-bill.dto';

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
}

/** Rupees, rounded to paise. Money arithmetic done in floats and left unrounded is
 * how a bill ends up a paisa out from its own components. */
function paise(value: number): number {
  return Math.round(value * 100) / 100;
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
}): { grossAmount: number; tdsAmount: number; netPayable: number } {
  const grossAmount = paise(params.billedHours * params.rate);
  const tdsAmount =
    params.tdsRate === null ? 0 : paise((grossAmount * params.tdsRate) / 100);
  return { grossAmount, tdsAmount, netPayable: paise(grossAmount - tdsAmount) };
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
    equipment: { select: { code: true, name: true } },
  } as const;

  private toRow(
    row: Prisma.HireBillGetPayload<{
      include: { equipment: { select: { code: true; name: true } } };
    }>,
    vendorName: string,
  ): HireBillRow {
    return {
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
        if (equipment.ownership !== EquipmentOwnership.hired) {
          throw new BadRequestException(
            `${equipment.code} is owned, not hired — a repair invoice for an owned ` +
              'machine is a service bill, not a hire bill (FR-022).',
          );
        }

        // Resolved at the period's *start*, not today, so a bill raised late still
        // costs what the machine cost when it was working (SC-006).
        const rate =
          dto.rate ??
          (await this.hireRates.getEffectiveHireRate(
            caller,
            equipment.categoryId,
            from,
          ));
        if (rate === null || rate === undefined) {
          throw new BadRequestException(
            'No hire rate is on file for this category on ' +
              `${dto.billingPeriodFrom.slice(
                0,
                10,
              )}. Add one under Machinery ` +
              'Masters, or supply a rate on the bill.',
          );
        }

        // A snapshot, not a live join (research.md §8): the bill must stay
        // verifiable against what the logbook said when it was raised, even if an
        // entry inside the period is corrected afterwards.
        const logbook = await tx.logbookEntry.aggregate({
          where: {
            equipmentId: dto.equipmentId,
            date: { gte: from, lte: to },
          },
          _sum: { totalHours: true },
        });
        const logbookHours = Number(logbook._sum.totalHours ?? 0);

        const amounts = computeHireBillAmounts({
          billedHours: dto.billedHours,
          rate,
          tdsRate: tds.tdsRate,
        });

        return tx.hireBill.create({
          data: {
            companyId: equipment.companyId,
            equipmentId: dto.equipmentId,
            vendorId: dto.vendorId,
            billedHours: dto.billedHours,
            rate,
            grossAmount: amounts.grossAmount,
            billingPeriodFrom: from,
            billingPeriodTo: to,
            logbookHours,
            variance:
              Math.round((dto.billedHours - logbookHours) * 1000) / 1000,
            tdsRate: tds.tdsRate,
            tdsAmount: amounts.tdsAmount,
            netPayable: amounts.netPayable,
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
        grossAmount: Number(created.grossAmount),
        netPayable: Number(created.netPayable),
      },
    });
    return this.toRow(created, vendorName);
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
            paymentDate: this.refs.parseDate(dto.paymentDate),
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
      changes: { status: 'paid', paymentReference: dto.paymentReference },
    });

    const vendorName = await this.refs.requireVendorName(caller, paid.vendorId);
    return this.toRow(paid, vendorName);
  }
}
