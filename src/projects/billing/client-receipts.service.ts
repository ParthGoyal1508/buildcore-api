import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  BankGuaranteeStatus,
  BankGuaranteeType,
  BillPackageStatus,
  ClientBillStatus,
  ClientHoldKind,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { BILLING_ERRORS } from './billing-error-codes';
import {
  RecordClientHoldReleaseDto,
  RecordClientReceiptDto,
} from './dto/client-receipt.dto';

const DEC = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);
const ZERO = DEC(0);
const fix = (value: Prisma.Decimal) => value.toDecimalPlaces(2).toFixed(2);

export interface ClientReceiptView {
  id: string;
  receivedOn: Date;
  amount: string;
  retentionAmount: string;
  cpbgAmount: string;
  tdsAmount: string;
  otherDeduction: string;
  otherDeductionNote: string | null;
  /** `amount` plus every deduction — how much of the bill this receipt settles. */
  settles: string;
  instrument: string;
  reference: string | null;
  remarks: string | null;
  recordedAt: Date;
}

/** A running PBG on a tender linked to the project — the guarantee that replaces CPBG. */
export interface RunningPbg {
  id: string;
  bgNumber: string | null;
  amount: string;
  expiryDate: Date | null;
  issuingBank: string | null;
}

export interface ClientBillReceipts {
  billId: string;
  billNumber: string;
  /**
   * What the bill is worth to settle: the issued package's work plus GST where the bill has one,
   * else the certified amount, else the billed gross. Receipts may not settle more than this.
   */
  billValue: string;
  /** Which of the three `billValue` came from — said, because the three differ. */
  billValueBasis: 'package' | 'certified' | 'billed';
  settled: string;
  outstanding: string;
  receipts: ClientReceiptView[];
  /**
   * What a new receipt's deductions are pre-filled with — the bill's own retention (or the
   * project's term), and the project's CPBG term — less what earlier receipts already withheld.
   * A suggestion; the receipt records what the client actually did.
   */
  suggested: { retentionAmount: string; cpbgAmount: string };
  /** A PBG is running for this project, so CPBG should no longer be deducted. */
  pbgRunning: boolean;
}

export interface ClientHoldings {
  projectId: string;
  /** Money received, and the bills it settled, across the project. */
  received: string;
  receiptCount: number;
  retention: { withheld: string; released: string; held: string };
  cpbg: { deducted: string; refunded: string; held: string };
  tds: string;
  otherDeductions: string;
  /** Retention plus CPBG still held — our money in the client's hands. */
  totalHeld: string;
  clientRetentionFraction: string | null;
  clientCpbgFraction: string | null;
  runningPbgs: RunningPbg[];
  /** CPBG is still held while a PBG is running: the client owes it back. */
  cpbgRefundDue: boolean;
  releases: {
    id: string;
    kind: ClientHoldKind;
    amount: string;
    releasedOn: Date;
    reason: string;
    bankGuaranteeId: string | null;
    bgNumber: string | null;
  }[];
}

/**
 * What the client paid us, and what it is holding back (048).
 *
 * Until this, a client bill stopped at `certified` and nothing recorded the money coming back —
 * so neither "what is the client still to pay" nor "how much of ours is the client holding"
 * could be answered. Both are **derived on read** from receipts and releases, never stored, for
 * the reason `RABillPayment` gives: a stored balance is a second answer that goes wrong silently
 * the first time an entry is corrected.
 */
@Injectable()
export class ClientReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async forBill(ctx: RlsContext, billId: string): Promise<ClientBillReceipts> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      this.billPosition(tx, billId),
    );
  }

  async record(
    ctx: RlsContext,
    billId: string,
    dto: RecordClientReceiptDto,
    actor: { userId: string; ipAddress: string },
  ): Promise<{ receipt: ClientReceiptView; position: ClientBillReceipts }> {
    const parts = {
      amount: DEC(dto.amount),
      retentionAmount: DEC(dto.retentionAmount ?? 0),
      cpbgAmount: DEC(dto.cpbgAmount ?? 0),
      tdsAmount: DEC(dto.tdsAmount ?? 0),
      otherDeduction: DEC(dto.otherDeduction ?? 0),
    };
    const settles = Object.values(parts).reduce((a, b) => a.plus(b), ZERO);
    if (settles.isZero()) {
      throw new BadRequestException({
        statusCode: 400,
        code: BILLING_ERRORS.receiptEmpty,
        message:
          'Every figure on this receipt is zero, so it settles nothing. Enter what was received.',
      });
    }

    const result = await withRlsContext(this.prisma, ctx, async (tx) => {
      const bill = await this.loadBill(tx, billId);
      if (bill.status === ClientBillStatus.draft) {
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.receiptBillDraft,
          message:
            `Bill ${bill.billNumber} is still a draft. Submit it to the client before recording ` +
            'money received against it — a draft can still change.',
        });
      }
      const before = await this.billPosition(tx, billId);
      const after = DEC(before.settled).plus(settles);
      if (after.greaterThan(DEC(before.billValue))) {
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.receiptExceedsBill,
          message:
            `This receipt settles ₹${fix(settles)}, which with the ₹${
              before.settled
            } already ` +
            `settled comes to ₹${fix(after)} — more than the bill's ₹${
              before.billValue
            } ` +
            `(${
              BASIS_WORDS[before.billValueBasis]
            }). Check for a double entry or a typed digit.`,
        });
      }

      const row = await tx.clientBillReceipt.create({
        data: {
          companyId: bill.companyId,
          projectId: bill.projectId,
          clientBillId: bill.id,
          receivedOn: new Date(dto.receivedOn),
          ...parts,
          otherDeductionNote: dto.otherDeductionNote?.trim() || null,
          instrument: dto.instrument,
          reference: dto.reference?.trim() || null,
          remarks: dto.remarks?.trim() || null,
          recordedByUserId: actor.userId,
        },
      });
      return {
        companyId: bill.companyId,
        receipt: viewOf(row),
        position: await this.billPosition(tx, billId),
      };
    });

    await this.audit.record({
      entityType: AuditEntityType.CLIENT_RECEIPT,
      action: AuditAction.CREATE,
      entityId: result.receipt.id,
      changes: {
        billId,
        ...result.receipt,
      } as unknown as Prisma.InputJsonValue,
      accountId: actor.userId,
      companyId: result.companyId,
      ipAddress: actor.ipAddress,
    });
    return { receipt: result.receipt, position: result.position };
  }

  /**
   * Removes a receipt entered in error (048). Refused once the client has released or refunded
   * more than the receipts left behind would have withheld — the release would then be of money
   * the records say was never held.
   */
  async remove(
    ctx: RlsContext,
    billId: string,
    receiptId: string,
    actor: { userId: string; ipAddress: string },
  ): Promise<ClientBillReceipts> {
    const result = await withRlsContext(this.prisma, ctx, async (tx) => {
      const receipt = await tx.clientBillReceipt.findFirst({
        where: { id: receiptId, clientBillId: billId },
      });
      if (!receipt)
        throw new NotFoundException('Receipt not found on this bill');

      const holdings = await this.holdingsIn(tx, receipt.projectId);
      if (
        DEC(holdings.retention.held).lessThan(receipt.retentionAmount) ||
        DEC(holdings.cpbg.held).lessThan(receipt.cpbgAmount)
      ) {
        throw new ConflictException({
          statusCode: 409,
          code: BILLING_ERRORS.receiptReleasedAgainst,
          message:
            'The client has already released or refunded money this receipt records as withheld. ' +
            'Removing it would leave a release of money the records say was never held.',
        });
      }
      await tx.clientBillReceipt.delete({ where: { id: receiptId } });
      return { receipt, position: await this.billPosition(tx, billId) };
    });

    await this.audit.record({
      entityType: AuditEntityType.CLIENT_RECEIPT,
      action: AuditAction.DELETE,
      entityId: receiptId,
      changes: {
        billId,
        ...viewOf(result.receipt),
      } as unknown as Prisma.InputJsonValue,
      accountId: actor.userId,
      companyId: result.receipt.companyId,
      ipAddress: actor.ipAddress,
    });
    return result.position;
  }

  async holdings(ctx: RlsContext, projectId: string): Promise<ClientHoldings> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId },
        select: { id: true },
      });
      if (!project) throw new NotFoundException('Project not found');
      return this.holdingsIn(tx, projectId);
    });
  }

  /** The same figures for many projects at once, for the report (constant queries). */
  async holdingsForProjects(
    ctx: RlsContext,
    projectIds: string[],
  ): Promise<Map<string, ClientHoldings>> {
    const out = new Map<string, ClientHoldings>();
    if (projectIds.length === 0) return out;
    await withRlsContext(this.prisma, ctx, async (tx) => {
      const sets = await this.loadHoldings(tx, projectIds);
      for (const id of projectIds) out.set(id, summarise(id, sets));
    });
    return out;
  }

  async release(
    ctx: RlsContext,
    projectId: string,
    dto: RecordClientHoldReleaseDto,
    actor: { userId: string; ipAddress: string },
  ): Promise<ClientHoldings> {
    const result = await withRlsContext(this.prisma, ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId },
        select: { id: true, companyId: true },
      });
      if (!project) throw new NotFoundException('Project not found');

      const before = await this.holdingsIn(tx, projectId);
      const held = DEC(
        dto.kind === ClientHoldKind.retention
          ? before.retention.held
          : before.cpbg.held,
      );
      if (DEC(dto.amount).greaterThan(held)) {
        const what =
          dto.kind === ClientHoldKind.retention ? 'retention' : 'CPBG';
        throw new BadRequestException({
          statusCode: 400,
          code: BILLING_ERRORS.holdReleaseExceedsHeld,
          message: `The client holds ₹${fix(
            held,
          )} of ${what} on this project; ₹${fix(
            DEC(dto.amount),
          )} cannot be released against it.`,
        });
      }

      let bankGuaranteeId: string | null = null;
      if (dto.bankGuaranteeId) {
        const guarantee = await tx.bankGuarantee.findFirst({
          where: {
            id: dto.bankGuaranteeId,
            type: BankGuaranteeType.PBG,
            tender: { projectId },
          },
          select: { id: true },
        });
        if (dto.kind !== ClientHoldKind.cpbg || !guarantee) {
          throw new BadRequestException({
            statusCode: 400,
            code: BILLING_ERRORS.holdReleaseGuaranteeMismatch,
            message:
              'Only a CPBG refund can name a guarantee, and it must be a PBG on a tender linked ' +
              'to this project.',
          });
        }
        bankGuaranteeId = guarantee.id;
      }

      const row = await tx.clientHoldRelease.create({
        data: {
          companyId: project.companyId,
          projectId,
          kind: dto.kind,
          amount: DEC(dto.amount),
          releasedOn: new Date(dto.releasedOn),
          reason: dto.reason.trim(),
          bankGuaranteeId,
          recordedByUserId: actor.userId,
        },
      });
      return {
        row,
        companyId: project.companyId,
        holdings: await this.holdingsIn(tx, projectId),
      };
    });

    await this.audit.record({
      entityType: AuditEntityType.CLIENT_HOLD_RELEASE,
      action: AuditAction.CREATE,
      entityId: result.row.id,
      changes: {
        projectId,
        kind: dto.kind,
        amount: fix(DEC(dto.amount)),
        releasedOn: dto.releasedOn,
        reason: dto.reason,
        bankGuaranteeId: result.row.bankGuaranteeId,
      },
      accountId: actor.userId,
      companyId: result.companyId,
      ipAddress: actor.ipAddress,
    });
    return result.holdings;
  }

  private async loadBill(tx: Prisma.TransactionClient, billId: string) {
    const bill = await tx.clientBill.findFirst({
      where: { id: billId },
      select: {
        id: true,
        companyId: true,
        projectId: true,
        billNumber: true,
        status: true,
        grossAmount: true,
        retentionAmount: true,
        certifiedAmount: true,
        project: {
          select: { clientRetentionFraction: true, clientCpbgFraction: true },
        },
        package: {
          select: {
            status: true,
            workDone: true,
            cgstAmount: true,
            sgstAmount: true,
            igstAmount: true,
            retentionAmount: true,
            performanceSecurity: true,
          },
        },
      },
    });
    if (!bill) throw new NotFoundException('Bill not found');
    return bill;
  }

  private async billPosition(
    tx: Prisma.TransactionClient,
    billId: string,
  ): Promise<ClientBillReceipts> {
    const bill = await this.loadBill(tx, billId);
    const [rows, pbgs] = await Promise.all([
      tx.clientBillReceipt.findMany({
        where: { clientBillId: billId },
        orderBy: [{ receivedOn: 'asc' }, { recordedAt: 'asc' }],
      }),
      this.runningPbgs(tx, [bill.projectId]),
    ]);
    const receipts = rows.map(viewOf);

    // The package is the invoice the client was actually sent, GST included, once it is past
    // approval. Without one, what the client certified, and failing that what we billed.
    const pkg = bill.package;
    const packageLive =
      pkg !== null &&
      pkg.status !== BillPackageStatus.draft &&
      pkg.status !== BillPackageStatus.abandoned;
    const basis: ClientBillReceipts['billValueBasis'] = packageLive
      ? 'package'
      : bill.certifiedAmount !== null
      ? 'certified'
      : 'billed';
    const billValue = packageLive
      ? pkg.workDone
          .plus(pkg.cgstAmount)
          .plus(pkg.sgstAmount)
          .plus(pkg.igstAmount)
      : bill.certifiedAmount ?? bill.grossAmount;

    const settled = rows.reduce(
      (sum, r) =>
        sum
          .plus(r.amount)
          .plus(r.retentionAmount)
          .plus(r.cpbgAmount)
          .plus(r.tdsAmount)
          .plus(r.otherDeduction),
      ZERO,
    );
    const withheldRetention = rows.reduce(
      (s, r) => s.plus(r.retentionAmount),
      ZERO,
    );
    const withheldCpbg = rows.reduce((s, r) => s.plus(r.cpbgAmount), ZERO);

    const gross = bill.certifiedAmount ?? bill.grossAmount;
    const retentionDue = packageLive
      ? pkg.retentionAmount
      : !bill.retentionAmount.isZero()
      ? bill.retentionAmount
      : gross.times(bill.project.clientRetentionFraction ?? 0);
    const cpbgDue =
      packageLive && !pkg.performanceSecurity.isZero()
        ? pkg.performanceSecurity
        : gross.times(bill.project.clientCpbgFraction ?? 0);
    const pbgRunning = pbgs.length > 0;
    const floor = (v: Prisma.Decimal) => (v.isNegative() ? ZERO : v);

    return {
      billId: bill.id,
      billNumber: bill.billNumber,
      billValue: fix(billValue),
      billValueBasis: basis,
      settled: fix(settled),
      outstanding: fix(floor(billValue.minus(settled))),
      receipts,
      suggested: {
        retentionAmount: fix(floor(retentionDue.minus(withheldRetention))),
        // Once a PBG is running, the cash deduction should stop (048).
        cpbgAmount: pbgRunning
          ? '0.00'
          : fix(floor(cpbgDue.minus(withheldCpbg))),
      },
      pbgRunning,
    };
  }

  private async holdingsIn(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<ClientHoldings> {
    return summarise(projectId, await this.loadHoldings(tx, [projectId]));
  }

  /** Every set the held-by-client figures are summed from, for many projects in four queries. */
  async loadHoldings(tx: Prisma.TransactionClient, projectIds: string[]) {
    const [receipts, releases, projects, pbgs] = await Promise.all([
      tx.clientBillReceipt.groupBy({
        by: ['projectId'],
        where: { projectId: { in: projectIds } },
        _sum: {
          amount: true,
          retentionAmount: true,
          cpbgAmount: true,
          tdsAmount: true,
          otherDeduction: true,
        },
        _count: { _all: true },
      }),
      tx.clientHoldRelease.findMany({
        where: { projectId: { in: projectIds } },
        orderBy: { releasedOn: 'asc' },
        include: { bankGuarantee: { select: { bgNumber: true } } },
      }),
      tx.project.findMany({
        where: { id: { in: projectIds } },
        select: {
          id: true,
          clientRetentionFraction: true,
          clientCpbgFraction: true,
        },
      }),
      this.runningPbgs(tx, projectIds),
    ]);
    return { receipts, releases, projects, pbgs };
  }

  /** PBGs issued (numbered) and running, on tenders linked to these projects. */
  private async runningPbgs(
    tx: Prisma.TransactionClient,
    projectIds: string[],
  ) {
    return tx.bankGuarantee.findMany({
      where: {
        type: BankGuaranteeType.PBG,
        status: BankGuaranteeStatus.RUNNING,
        bgNumber: { not: null },
        tender: { projectId: { in: projectIds } },
      },
      select: {
        id: true,
        bgNumber: true,
        amount: true,
        expiryDate: true,
        issuingBank: true,
        tender: { select: { projectId: true } },
      },
      orderBy: { expiryDate: 'asc' },
    });
  }
}

const BASIS_WORDS: Record<ClientBillReceipts['billValueBasis'], string> = {
  package: 'the issued package, GST included',
  certified: 'as certified',
  billed: 'as billed',
};

type ReceiptRow = {
  id: string;
  receivedOn: Date;
  amount: Prisma.Decimal;
  retentionAmount: Prisma.Decimal;
  cpbgAmount: Prisma.Decimal;
  tdsAmount: Prisma.Decimal;
  otherDeduction: Prisma.Decimal;
  otherDeductionNote: string | null;
  instrument: string;
  reference: string | null;
  remarks: string | null;
  recordedAt: Date;
};

function viewOf(row: ReceiptRow): ClientReceiptView {
  return {
    id: row.id,
    receivedOn: row.receivedOn,
    amount: fix(row.amount),
    retentionAmount: fix(row.retentionAmount),
    cpbgAmount: fix(row.cpbgAmount),
    tdsAmount: fix(row.tdsAmount),
    otherDeduction: fix(row.otherDeduction),
    otherDeductionNote: row.otherDeductionNote,
    settles: fix(
      row.amount
        .plus(row.retentionAmount)
        .plus(row.cpbgAmount)
        .plus(row.tdsAmount)
        .plus(row.otherDeduction),
    ),
    instrument: row.instrument,
    reference: row.reference,
    remarks: row.remarks,
    recordedAt: row.recordedAt,
  };
}

function summarise(
  projectId: string,
  sets: Awaited<ReturnType<ClientReceiptsService['loadHoldings']>>,
): ClientHoldings {
  const sums = sets.receipts.find((r) => r.projectId === projectId);
  const releases = sets.releases.filter((r) => r.projectId === projectId);
  const project = sets.projects.find((p) => p.id === projectId);
  const pbgs = sets.pbgs.filter((g) => g.tender.projectId === projectId);

  const released = (kind: ClientHoldKind) =>
    releases
      .filter((r) => r.kind === kind)
      .reduce((s, r) => s.plus(r.amount), ZERO);
  const withheld = sums?._sum.retentionAmount ?? ZERO;
  const deducted = sums?._sum.cpbgAmount ?? ZERO;
  const retentionHeld = withheld.minus(released(ClientHoldKind.retention));
  const cpbgHeld = deducted.minus(released(ClientHoldKind.cpbg));

  return {
    projectId,
    received: fix(sums?._sum.amount ?? ZERO),
    receiptCount: sums?._count._all ?? 0,
    retention: {
      withheld: fix(withheld),
      released: fix(released(ClientHoldKind.retention)),
      held: fix(retentionHeld),
    },
    cpbg: {
      deducted: fix(deducted),
      refunded: fix(released(ClientHoldKind.cpbg)),
      held: fix(cpbgHeld),
    },
    tds: fix(sums?._sum.tdsAmount ?? ZERO),
    otherDeductions: fix(sums?._sum.otherDeduction ?? ZERO),
    totalHeld: fix(retentionHeld.plus(cpbgHeld)),
    clientRetentionFraction:
      project?.clientRetentionFraction?.toFixed(6) ?? null,
    clientCpbgFraction: project?.clientCpbgFraction?.toFixed(6) ?? null,
    runningPbgs: pbgs.map((g) => ({
      id: g.id,
      bgNumber: g.bgNumber,
      amount: fix(g.amount),
      expiryDate: g.expiryDate,
      issuingBank: g.issuingBank,
    })),
    cpbgRefundDue: pbgs.length > 0 && cpbgHeld.greaterThan(0),
    releases: releases.map((r) => ({
      id: r.id,
      kind: r.kind,
      amount: fix(r.amount),
      releasedOn: r.releasedOn,
      reason: r.reason,
      bankGuaranteeId: r.bankGuaranteeId,
      bgNumber: r.bankGuarantee?.bgNumber ?? null,
    })),
  };
}
