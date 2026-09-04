import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  ServiceBillPaymentStatus,
  ServiceBillStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/plant.constants';
import { PlantRefsService } from '../plant-refs.service';
import {
  CreateServiceBillDto,
  ListServiceBillsDto,
  PayServiceBillDto,
} from './dto/service-bill.dto';

export interface ServiceBillRow {
  id: string;
  companyId: string;
  maintenanceJobId: string;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  vendorId: string;
  vendorName: string;
  billNumber: string;
  billDate: Date;
  grossAmount: number;
  taxAmount: number;
  tdsPercent: number;
  tdsAmount: number;
  netPayable: number;
  status: ServiceBillStatus;
  verifiedByUserId: string | null;
  verifiedAt: Date | null;
  paymentStatus: ServiceBillPaymentStatus;
  paidAmount: number;
  paidOn: Date | null;
  paymentReference: string | null;
  createdAt: Date;
}

function paise(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A service bill's computed figures (FR-021).
 *
 * TDS is deducted on the gross, not on gross + tax: tax collected on behalf of the
 * state is not the vendor's income, and withholding on it would over-deduct. The
 * net payable is therefore `gross + tax − tds`.
 *
 * Pulled out of the service so the arithmetic is testable without a database, and
 * so there is exactly one definition of it.
 */
export function computeServiceBillAmounts(params: {
  grossAmount: number;
  taxAmount: number;
  tdsPercent: number;
}): { tdsAmount: number; netPayable: number } {
  const tdsAmount = paise((params.grossAmount * params.tdsPercent) / 100);
  return {
    tdsAmount,
    netPayable: paise(params.grossAmount + params.taxAmount - tdsAmount),
  };
}

/**
 * Third-party service bills against maintenance jobs (006 US11).
 *
 * Distinct from `HireBill` (FR-022): a service bill is what a workshop charges to
 * repair a machine you own; a hire bill is what an owner charges to let you use
 * theirs. The same invoice is never both, and this service will not attach one to a
 * hire.
 *
 * Recordable against a *closed* job on purpose (US11 scenario 7): invoices routinely
 * arrive weeks after the work is finished, and refusing them would force people to
 * either leave jobs open or record the cost nowhere.
 */
@Injectable()
export class ServiceBillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: PlantRefsService,
  ) {}

  private readonly include = {
    maintenanceJob: {
      select: {
        equipmentId: true,
        equipment: { select: { code: true, name: true } },
      },
    },
  } as const;

  private toRow(
    row: Prisma.ServiceBillGetPayload<{
      include: {
        maintenanceJob: {
          select: {
            equipmentId: true;
            equipment: { select: { code: true; name: true } };
          };
        };
      };
    }>,
    vendorName: string,
  ): ServiceBillRow {
    return {
      id: row.id,
      companyId: row.companyId,
      maintenanceJobId: row.maintenanceJobId,
      equipmentId: row.maintenanceJob.equipmentId,
      equipmentCode: row.maintenanceJob.equipment.code,
      equipmentName: row.maintenanceJob.equipment.name,
      vendorId: row.vendorId,
      vendorName,
      billNumber: row.billNumber,
      billDate: row.billDate,
      grossAmount: Number(row.grossAmount),
      taxAmount: Number(row.taxAmount),
      tdsPercent: Number(row.tdsPercent),
      tdsAmount: Number(row.tdsAmount),
      netPayable: Number(row.netPayable),
      status: row.status,
      verifiedByUserId: row.verifiedByUserId,
      verifiedAt: row.verifiedAt,
      paymentStatus: row.paymentStatus,
      paidAmount: Number(row.paidAmount),
      paidOn: row.paidOn,
      paymentReference: row.paymentReference,
      createdAt: row.createdAt,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListServiceBillsDto,
  ): Promise<{
    items: ServiceBillRow[];
    total: number;
    page: number;
    pageSize: number;
    pendingPaymentTotal: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      query.pageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: Prisma.ServiceBillWhereInput = {
      ...companyScope(caller, query.companyId),
      deletedAt: null,
      ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      ...(query.maintenanceJobId
        ? { maintenanceJobId: query.maintenanceJobId }
        : {}),
      ...(query.equipmentId
        ? { maintenanceJob: { equipmentId: query.equipmentId } }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
      ...(query.from || query.to
        ? {
            billDate: {
              ...(query.from ? { gte: this.refs.parseDate(query.from) } : {}),
              ...(query.to ? { lte: this.refs.parseDate(query.to) } : {}),
            },
          }
        : {}),
    };

    const { rows, total, pending } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, total, pending] = await Promise.all([
          tx.serviceBill.findMany({
            where,
            orderBy: [{ billDate: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: this.include,
          }),
          tx.serviceBill.count({ where }),
          // The pending-payment summary US11 scenario 8 asks for, over the whole
          // filtered company rather than the page: a total that changed as you
          // paged would be useless.
          tx.serviceBill.findMany({
            where: {
              ...companyScope(caller, query.companyId),
              deletedAt: null,
              paymentStatus: { not: ServiceBillPaymentStatus.paid },
            },
            select: { netPayable: true, paidAmount: true },
          }),
        ]);
        return { rows, total, pending };
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
      pendingPaymentTotal: paise(
        pending.reduce(
          (sum, bill) =>
            sum + Number(bill.netPayable) - Number(bill.paidAmount),
          0,
        ),
      ),
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateServiceBillDto,
    ipAddress: string,
  ): Promise<ServiceBillRow> {
    const vendorName = await this.refs.requireVendorName(caller, dto.vendorId);
    const vendorTds = await this.refs.vendorTds(caller, dto.vendorId);
    const tdsPercent = dto.tdsPercent ?? vendorTds.tdsRate ?? 0;
    const billNumber = dto.billNumber.trim().toUpperCase();

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const job = await tx.maintenanceJob.findUnique({
          where: { id: dto.maintenanceJobId },
        });
        if (!job) {
          throw new BadRequestException(
            `Maintenance job ${dto.maintenanceJobId} does not exist.`,
          );
        }
        assertInScope(caller, job, 'Maintenance job');

        const clash = await tx.serviceBill.findFirst({
          where: {
            companyId: job.companyId,
            vendorId: dto.vendorId,
            billNumber,
          },
        });
        if (clash) {
          throw new ConflictException(
            `Bill ${billNumber} is already recorded against this vendor.`,
          );
        }

        const amounts = computeServiceBillAmounts({
          grossAmount: dto.grossAmount,
          taxAmount: dto.taxAmount ?? 0,
          tdsPercent,
        });

        return tx.serviceBill.create({
          data: {
            companyId: job.companyId,
            maintenanceJobId: dto.maintenanceJobId,
            vendorId: dto.vendorId,
            billNumber,
            billDate: this.refs.parseDate(dto.billDate),
            grossAmount: dto.grossAmount,
            taxAmount: dto.taxAmount ?? 0,
            tdsPercent,
            tdsAmount: amounts.tdsAmount,
            netPayable: amounts.netPayable,
          },
          include: this.include,
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SERVICE_BILL,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
      changes: {
        maintenanceJobId: created.maintenanceJobId,
        vendorId: created.vendorId,
        billNumber: created.billNumber,
        netPayable: Number(created.netPayable),
      },
    });
    return this.toRow(created, vendorName);
  }

  /**
   * Verifies a bill, freezing its figures (FR-023).
   *
   * There is no update path once verified: a verified bill is what the machine's
   * maintenance cost and the project's P&L are both computed from, and letting the
   * amounts move afterwards would restate figures already reported.
   */
  async verify(
    caller: AuthenticatedUser,
    billId: string,
    ipAddress: string,
  ): Promise<ServiceBillRow> {
    const verified = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.serviceBill.findUnique({
          where: { id: billId },
        });
        if (!existing || existing.deletedAt !== null) {
          throw new NotFoundException('Service bill not found');
        }
        assertInScope(caller, existing, 'Service bill');
        if (existing.status === ServiceBillStatus.verified) {
          throw new ConflictException('This bill is already verified.');
        }
        return tx.serviceBill.update({
          where: { id: billId },
          data: {
            status: ServiceBillStatus.verified,
            verifiedByUserId: caller.id,
            verifiedAt: new Date(),
          },
          include: this.include,
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SERVICE_BILL,
      action: AuditAction.UPDATE,
      entityId: billId,
      accountId: caller.id,
      companyId: verified.companyId,
      ipAddress,
      changes: { status: 'verified', netPayable: Number(verified.netPayable) },
    });

    const vendorName = await this.refs.requireVendorName(
      caller,
      verified.vendorId,
    );
    return this.toRow(verified, vendorName);
  }

  /**
   * Records a payment (FR-023).
   *
   * Refused against an unverified bill: paying an invoice nobody has checked is the
   * exact control this state machine exists to impose. A payment short of the net
   * payable marks the bill `partially_paid` rather than `paid`, and payments
   * accumulate — a workshop paid in two instalments is a normal thing, not an error.
   */
  async pay(
    caller: AuthenticatedUser,
    billId: string,
    dto: PayServiceBillDto,
    ipAddress: string,
  ): Promise<ServiceBillRow> {
    const paid = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.serviceBill.findUnique({
          where: { id: billId },
        });
        if (!existing || existing.deletedAt !== null) {
          throw new NotFoundException('Service bill not found');
        }
        assertInScope(caller, existing, 'Service bill');
        if (existing.status !== ServiceBillStatus.verified) {
          throw new ConflictException(
            'This bill has not been verified yet. Verify it before recording a payment.',
          );
        }

        const paidAmount = paise(Number(existing.paidAmount) + dto.paidAmount);
        const netPayable = Number(existing.netPayable);
        if (paidAmount > netPayable) {
          throw new BadRequestException(
            `Total paid (${paidAmount}) would exceed the net payable (${netPayable}).`,
          );
        }

        return tx.serviceBill.update({
          where: { id: billId },
          data: {
            paidAmount,
            paidOn: this.refs.parseDate(dto.paidOn),
            paymentReference: dto.paymentReference.trim(),
            paymentStatus:
              paidAmount >= netPayable
                ? ServiceBillPaymentStatus.paid
                : ServiceBillPaymentStatus.partially_paid,
          },
          include: this.include,
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SERVICE_BILL,
      action: AuditAction.UPDATE,
      entityId: billId,
      accountId: caller.id,
      companyId: paid.companyId,
      ipAddress,
      changes: {
        paidAmount: dto.paidAmount,
        paymentStatus: paid.paymentStatus,
        paymentReference: dto.paymentReference,
      },
    });

    const vendorName = await this.refs.requireVendorName(caller, paid.vendorId);
    return this.toRow(paid, vendorName);
  }

  /**
   * Soft-deletes a bill (FR-027).
   *
   * Never a hard delete: the bill is part of a machine's cost history and of any
   * P&L already reported for the period. A verified bill cannot be removed at all —
   * withdraw it by recording a credit note against the vendor instead.
   */
  async remove(
    caller: AuthenticatedUser,
    billId: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.serviceBill.findUnique({
          where: { id: billId },
        });
        if (!existing || existing.deletedAt !== null) {
          throw new NotFoundException('Service bill not found');
        }
        assertInScope(caller, existing, 'Service bill');
        if (existing.status === ServiceBillStatus.verified) {
          throw new ConflictException(
            'A verified bill cannot be removed — its figures are already part of ' +
              "this machine's maintenance cost.",
          );
        }
        return tx.serviceBill.update({
          where: { id: billId },
          data: { deletedAt: new Date() },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.SERVICE_BILL,
      action: AuditAction.DELETE,
      entityId: billId,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
      changes: { billNumber: removed.billNumber, softDeleted: true },
    });
  }
}
