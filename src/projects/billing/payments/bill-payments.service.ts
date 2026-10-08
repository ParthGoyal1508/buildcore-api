import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentInstrument, Prisma, RaBillStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import { BILLING_ERRORS } from '../billing-error-codes';

/** One payment, as a screen reads it. */
export interface PaymentView {
  id: string;
  raBillId: string;
  paidOn: string;
  amount: string;
  instrument: PaymentInstrument;
  reference: string | null;
  remarks: string | null;
  recordedAt: string;
}

/** What one bill is owed, and what has been paid against it (FR-021). */
export interface BillOutstandingView {
  raBillId: string;
  billNumber: string;
  projectId: string;
  workOrderId: string | null;
  status: RaBillStatus;
  /** Null until the signed copy comes back (FR-020). */
  acknowledgedOn: string | null;
  certifiedAmount: string;
  paidAmount: string;
  /** **Derived, never stored** — `certifiedAmount` less `paidAmount`. */
  outstandingAmount: string;
  payments: PaymentView[];
}

/** One subcontractor's position across every bill of theirs (FR-021). */
export interface SubcontractorOutstandingView {
  partnerId: string;
  certifiedAmount: string;
  paidAmount: string;
  outstandingAmount: string;
  bills: BillOutstandingView[];
}

const ZERO = new Prisma.Decimal(0);

/**
 * Money that actually left, against a running-account bill (028 FR-021).
 *
 * ## What was missing
 *
 * A bill reached `approved` — certified — and stopped. Nothing recorded that it had been paid, so
 * the one figure anybody actually asks for, *what is this subcontractor still owed*, could not be
 * answered from this system at all. It was answered from a spreadsheet, which is why two people
 * had two answers.
 *
 * ## Outstanding is derived, and there is no column for it
 *
 * `certifiedAmount - Σ payments`, computed on read. **No `balance` or `outstanding` column exists**
 * on `RABill` or on `RABillPayment`, deliberately: a stored balance is a second source of truth,
 * and the first time somebody corrects a payment it goes wrong *silently*. Silently is the worst
 * way for a money figure to be wrong, because nothing downstream disagrees with it.
 *
 * The derivation is done in `Prisma.Decimal` throughout. A payment summed as a JavaScript number
 * leaves an outstanding of `0.000000000004` on a bill that is fully paid, and a bill that will not
 * close is a bill somebody chases.
 *
 * ## Certified, for a subcontractor bill, is `netPayable`
 *
 * `ClientBill` carries its own `certifiedAmount` — what the client agreed to pay *us*. An RA bill
 * has no such column and does not need one: what is owed to a subcontractor is the net after
 * retention and recoveries, which is `netPayable`, and the bill reaching `approved` is what
 * certifies it. Reading gross here would overpay by exactly the deductions.
 *
 * ## Why a draft cannot be paid
 *
 * An uncertified bill has no agreed figure to be outstanding against, and its quantities can still
 * change. Money paid to a subcontractor before certification is an **advance**, which is recovered
 * through the bill package's adjustment columns — where Phase B put every deduction. Recording it
 * as a payment here would both understate the advance recovery and overstate what has been settled.
 */
@Injectable()
export class BillPaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a payment against a certified bill. Partial by design (FR-021).
   *
   * Refuses a payment that would take the total past what was certified. That refusal is not
   * bookkeeping tidiness: the overpayment it describes is either the same payment entered twice or
   * a digit typed wrong, and both are cheaper to find here than in a reconciliation in March.
   */
  async record(
    ctx: RlsContext,
    companyId: string,
    raBillId: string,
    input: {
      paidOn: string;
      amount: string;
      instrument: PaymentInstrument;
      reference?: string | null;
      remarks?: string | null;
    },
    actor: { userId: string | null },
  ): Promise<BillOutstandingView> {
    const amount = new Prisma.Decimal(input.amount);
    if (amount.lessThanOrEqualTo(ZERO)) {
      throw new BadRequestException(
        'A payment is a positive amount. To correct one, delete it and record it again.',
      );
    }

    await withRlsContext(this.prisma, ctx, async (tx) => {
      const bill = await tx.rABill.findFirst({
        where: { id: raBillId },
        select: { id: true, billNumber: true, status: true, netPayable: true },
      });
      // 404 and not 403: a 403 would confirm the bill exists in somebody else's company.
      if (!bill) throw new NotFoundException('RA bill not found');

      if (bill.status !== RaBillStatus.approved) {
        throw new ConflictException({
          statusCode: 409,
          code: BILLING_ERRORS.paymentBillNotCertified,
          message:
            `${bill.billNumber} has not been certified, so there is no agreed figure to pay ` +
            'against and its quantities can still change. Money paid before certification is an ' +
            'advance — record it as an advance recovery on the bill package instead.',
        });
      }

      const paid = await tx.rABillPayment.aggregate({
        where: { raBillId },
        _sum: { amount: true },
      });
      const alreadyPaid = paid._sum.amount ?? ZERO;
      if (alreadyPaid.plus(amount).greaterThan(bill.netPayable)) {
        throw new ConflictException({
          statusCode: 409,
          code: BILLING_ERRORS.paymentExceedsCertified,
          message:
            `${bill.billNumber} was certified at ${bill.netPayable.toFixed(
              2,
            )} and ${alreadyPaid.toFixed(2)} has already been paid. ` +
            `Paying ${amount.toFixed(
              2,
            )} would take the total past it — which is either this ` +
            'payment entered twice or a digit typed wrong.',
        });
      }

      await tx.rABillPayment.create({
        data: {
          companyId,
          raBillId,
          // Date-only, to match the column: a payment made on the 28th must not read as the 27th
          // for anybody west of here.
          paidOn: new Date(`${input.paidOn.slice(0, 10)}T00:00:00.000Z`),
          amount,
          instrument: input.instrument,
          reference: input.reference ?? null,
          remarks: input.remarks ?? null,
          recordedByUserId: actor.userId,
        },
      });
    });

    return this.outstandingForBill(ctx, raBillId);
  }

  /** Removes a payment recorded in error. The only correction route — a payment is never edited. */
  async remove(ctx: RlsContext, paymentId: string): Promise<void> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      // `deleteMany` rather than `delete`: under row-level security a `delete` by primary key on
      // another company's row raises a Prisma not-found that reads as a bug, where this returns a
      // count the caller can turn into the 404 it actually is.
      const removed = await tx.rABillPayment.deleteMany({
        where: { id: paymentId },
      });
      if (removed.count === 0) throw new NotFoundException('Payment not found');
    });
  }

  /** One bill's position: certified, paid, and what is left (FR-021). */
  async outstandingForBill(
    ctx: RlsContext,
    raBillId: string,
  ): Promise<BillOutstandingView> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const bill = await tx.rABill.findFirst({
        where: { id: raBillId },
        select: {
          id: true,
          billNumber: true,
          projectId: true,
          workOrderId: true,
          status: true,
          netPayable: true,
          acknowledgedAt: true,
          payments: { orderBy: { paidOn: 'asc' } },
        },
      });
      if (!bill) throw new NotFoundException('RA bill not found');
      return toBillView(bill);
    });
  }

  /**
   * One subcontractor's position across **every** bill of theirs (FR-021).
   *
   * Across, not per bill, because that is the question: a subcontractor asking what they are owed
   * is not asking about RA-03. Answering it bill by bill is what sends somebody to a spreadsheet to
   * add six figures up, and the figure they come back with is the one that gets paid.
   *
   * Bills are reached through their work order, which is where `partnerId` lives. A bill with no
   * work order cannot be attributed to a subcontractor at all and is therefore absent here rather
   * than attributed to a guess.
   */
  async outstandingForSubcontractor(
    ctx: RlsContext,
    partnerId: string,
  ): Promise<SubcontractorOutstandingView> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const bills = await tx.rABill.findMany({
        where: {
          workOrder: { partnerId },
          // Only certified bills carry an agreed figure. A draft included here would report an
          // outstanding against an amount nobody has agreed to pay.
          status: RaBillStatus.approved,
        },
        select: {
          id: true,
          billNumber: true,
          projectId: true,
          workOrderId: true,
          status: true,
          netPayable: true,
          acknowledgedAt: true,
          payments: { orderBy: { paidOn: 'asc' } },
        },
        orderBy: [{ billingDate: 'asc' }, { billNumber: 'asc' }],
      });

      const views = bills.map(toBillView);
      const certified = views.reduce(
        (total, view) => total.plus(view.certifiedAmount),
        ZERO,
      );
      const paid = views.reduce(
        (total, view) => total.plus(view.paidAmount),
        ZERO,
      );

      return {
        partnerId,
        certifiedAmount: certified.toFixed(2),
        paidAmount: paid.toFixed(2),
        outstandingAmount: certified.minus(paid).toFixed(2),
        bills: views,
      };
    });
  }
}

type BillEntity = {
  id: string;
  billNumber: string;
  projectId: string;
  workOrderId: string | null;
  status: RaBillStatus;
  netPayable: Prisma.Decimal;
  acknowledgedAt: Date | null;
  payments: {
    id: string;
    raBillId: string;
    paidOn: Date;
    amount: Prisma.Decimal;
    instrument: PaymentInstrument;
    reference: string | null;
    remarks: string | null;
    recordedAt: Date;
  }[];
};

function toBillView(bill: BillEntity): BillOutstandingView {
  // Summed as `Decimal`, never as a number. Three part payments of a third each leave an
  // outstanding of 0.000000000004 in floating point, and a bill that will not close is a bill
  // somebody chases.
  const paid = bill.payments.reduce(
    (total, payment) => total.plus(payment.amount),
    ZERO,
  );

  return {
    raBillId: bill.id,
    billNumber: bill.billNumber,
    projectId: bill.projectId,
    workOrderId: bill.workOrderId,
    status: bill.status,
    acknowledgedOn: bill.acknowledgedAt?.toISOString() ?? null,
    certifiedAmount: bill.netPayable.toFixed(2),
    paidAmount: paid.toFixed(2),
    outstandingAmount: bill.netPayable.minus(paid).toFixed(2),
    payments: bill.payments.map((payment) => ({
      id: payment.id,
      raBillId: payment.raBillId,
      paidOn: payment.paidOn.toISOString().slice(0, 10),
      amount: payment.amount.toFixed(2),
      instrument: payment.instrument,
      reference: payment.reference,
      remarks: payment.remarks,
      recordedAt: payment.recordedAt.toISOString(),
    })),
  };
}
