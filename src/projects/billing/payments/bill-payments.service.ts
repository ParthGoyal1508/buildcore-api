import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentInstrument, Prisma, RaBillStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  cashHiddenError,
  isCashHiddenTx,
} from '../../../common/cash/cash-policy';
import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import { BILLING_ERRORS } from '../billing-error-codes';
import {
  cashHiddenCompaniesTx,
  isCashPayment,
  paymentVisible,
} from './cash-payments';

/** One payment, as a screen reads it. */
export interface PaymentView {
  id: string;
  raBillId: string;
  paidOn: string;
  amount: string;
  instrument: PaymentInstrument;
  reference: string | null;
  remarks: string | null;
  transactionNo: string | null;
  tdsAmount: string;
  mode: string | null;
  particulars: string | null;
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

/**
 * One project's subcontractor billing position (2026-10-12).
 *
 * Raised and certified are separate counts because they answer different questions — "how much
 * have they claimed" and "how much have we agreed" — and the gap between the two is a negotiation
 * in progress rather than an error.
 */
export interface ProjectBillingPosition {
  /** Every bill against the project, whatever its status. */
  raisedCount: number;
  raisedAmount: string;
  /** Those that reached `approved`, which is what certifies a subcontractor bill. */
  certifiedCount: number;
  certifiedAmount: string;
  paidAmount: string;
  /** **Derived, never stored** — certified less paid. */
  outstandingAmount: string;
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
      transactionNo?: string | null;
      tdsAmount?: string | null;
      mode?: string | null;
      particulars?: string | null;
    },
    actor: { userId: string | null },
  ): Promise<BillOutstandingView & { recordedPaymentId: string }> {
    const amount = new Prisma.Decimal(input.amount);
    if (amount.lessThanOrEqualTo(ZERO)) {
      throw new BadRequestException(
        'A payment is a positive amount. To correct one, delete it and record it again.',
      );
    }

    const recordedPaymentId = await withRlsContext(
      this.prisma,
      ctx,
      async (tx) => {
        // 038. With cash hidden for the company nobody records cash — `instrument = cash`, or a mode
        // spelled "Cash" that the request interceptor's exact match lets through.
        const hidden = await isCashHiddenTx(tx, companyId);
        if (hidden && isCashPayment(input)) throw cashHiddenError();

        // 036 I4. The bill row is locked before the paid-to-date sum is read, and held until the
        // payment is inserted. Without it the check was aggregate-then-insert, and two payments
        // submitted together each read the same paid figure, each passed, and together paid past
        // what was certified. Locking the bill (not the payments) serialises exactly the payments
        // against one bill, the way inventory payments lock their purchase bills. Under RLS, so a
        // bill in another company locks nothing and is reported as not found below.
        await tx.$queryRaw`
          SELECT "id" FROM "projects"."RABill" WHERE "id" = ${raBillId} FOR UPDATE
        `;
        const bill = await tx.rABill.findFirst({
          where: { id: raBillId },
          select: {
            id: true,
            billNumber: true,
            status: true,
            netPayable: true,
          },
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
        // The ceiling counts every payment, cash included — money that left is not paid twice
        // because it is hidden. The message, though, names only what the reader may see (038).
        if (alreadyPaid.plus(amount).greaterThan(bill.netPayable)) {
          const shownPaid = hidden
            ? (
                await tx.rABillPayment.findMany({
                  where: { raBillId },
                  select: { amount: true, instrument: true, mode: true },
                })
              )
                .filter((payment) => !isCashPayment(payment))
                .reduce((total, payment) => total.plus(payment.amount), ZERO)
            : alreadyPaid;
          throw new ConflictException({
            statusCode: 409,
            code: BILLING_ERRORS.paymentExceedsCertified,
            message:
              `${bill.billNumber} was certified at ${bill.netPayable.toFixed(
                2,
              )} and ${shownPaid.toFixed(2)} has already been paid. ` +
              `Paying ${amount.toFixed(
                2,
              )} would take the total past it — which is either this ` +
              'payment entered twice or a digit typed wrong.',
          });
        }

        const created = await tx.rABillPayment.create({
          select: { id: true },
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
            transactionNo: input.transactionNo ?? null,
            tdsAmount: new Prisma.Decimal(input.tdsAmount || '0'),
            mode: input.mode ?? null,
            particulars: input.particulars?.trim() || null,
            recordedByUserId: actor.userId,
          },
        });
        return created.id;
      },
    );

    // Returned so the caller can produce this payment's advice straight away.
    return {
      ...(await this.outstandingForBill(ctx, raBillId)),
      recordedPaymentId,
    };
  }

  /** Removes a payment recorded in error. The only correction route — a payment is never edited. */
  async remove(ctx: RlsContext, paymentId: string): Promise<void> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      // 038. A cash payment of a company hiding cash cannot be removed until cash is shown again.
      const existing = await tx.rABillPayment.findFirst({
        where: { id: paymentId },
        select: { companyId: true, instrument: true, mode: true },
      });
      if (
        existing &&
        isCashPayment(existing) &&
        (await isCashHiddenTx(tx, existing.companyId))
      ) {
        throw cashHiddenError();
      }
      // `deleteMany` rather than `delete`: under row-level security a `delete` by primary key on
      // another company's row raises a Prisma not-found that reads as a bug, where this returns a
      // count the caller can turn into the 404 it actually is.
      const removed = await tx.rABillPayment.deleteMany({
        where: { id: paymentId },
      });
      if (removed.count === 0) throw new NotFoundException('Payment not found');
    });
  }

  /**
   * A whole project's position across its subcontractor bills (2026-10-12).
   *
   * Here rather than in `ProjectsService` so there is **one** definition of what "certified" and
   * "paid" mean for a running-account bill. The rule is not obvious — certified is `netPayable` on
   * a bill that reached `approved`, not `amount`, and not a bill in any other status — and this
   * class's docblock is where it is written down. A second summation computed next to the project
   * query would be free to drift from it, and the two figures would then disagree on screens that
   * sit beside each other.
   *
   * Decimal throughout, for the reason recorded above: a project's bills summed as JavaScript
   * numbers leave an outstanding of a fraction of a paisa on a project that is fully settled.
   */
  async positionForProject(
    ctx: RlsContext,
    projectId: string,
  ): Promise<ProjectBillingPosition> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const bills = await tx.rABill.findMany({
        where: { projectId },
        select: {
          companyId: true,
          status: true,
          amount: true,
          netPayable: true,
          payments: {
            select: { amount: true, instrument: true, mode: true },
          },
        },
      });
      // 038: paid is summed without the cash payments of a company hiding cash.
      const hidden = await cashHiddenCompaniesTx(tx, ctx);

      const certified = bills.filter(
        (bill) => bill.status === RaBillStatus.approved,
      );
      const sum = <T>(rows: T[], of: (row: T) => Prisma.Decimal) =>
        rows.reduce((total, row) => total.plus(of(row)), ZERO);

      const certifiedAmount = sum(certified, (bill) => bill.netPayable);
      // Paid across **every** bill, not only the certified ones. A payment cannot be recorded
      // against an uncertified bill — `record` refuses it — so this is the same set by another
      // route; summing the wider one means a bill whose status is later corrected cannot strand
      // money that has demonstrably left.
      const paidAmount = sum(bills, (bill) =>
        sum(
          bill.payments.filter((payment) =>
            paymentVisible(hidden, bill.companyId, payment),
          ),
          (payment) => payment.amount,
        ),
      );

      return {
        raisedCount: bills.length,
        raisedAmount: sum(bills, (bill) => bill.amount).toFixed(2),
        certifiedCount: certified.length,
        certifiedAmount: certifiedAmount.toFixed(2),
        paidAmount: paidAmount.toFixed(2),
        outstandingAmount: certifiedAmount.minus(paidAmount).toFixed(2),
      };
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
          companyId: true,
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
      return toBillView(bill, await cashHiddenCompaniesTx(tx, ctx));
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
          companyId: true,
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

      const hidden = await cashHiddenCompaniesTx(tx, ctx);
      const views = bills.map((bill) => toBillView(bill, hidden));
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
  companyId?: string;
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
    transactionNo: string | null;
    tdsAmount: Prisma.Decimal;
    mode: string | null;
    particulars: string | null;
    recordedAt: Date;
  }[];
};

function toBillView(
  bill: BillEntity,
  hidden: ReadonlySet<string> = new Set(),
): BillOutstandingView {
  // 038. A cash payment of a company hiding cash is not shown and not summed: the bill reads as
  // though it had never been made, and outstanding rises by it.
  const payments = bill.payments.filter((payment) =>
    paymentVisible(hidden, bill.companyId, payment),
  );
  // Summed as `Decimal`, never as a number. Three part payments of a third each leave an
  // outstanding of 0.000000000004 in floating point, and a bill that will not close is a bill
  // somebody chases.
  const paid = payments.reduce(
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
    payments: payments.map((payment) => ({
      id: payment.id,
      raBillId: payment.raBillId,
      paidOn: payment.paidOn.toISOString().slice(0, 10),
      amount: payment.amount.toFixed(2),
      instrument: payment.instrument,
      reference: payment.reference,
      remarks: payment.remarks,
      transactionNo: payment.transactionNo,
      tdsAmount: payment.tdsAmount.toFixed(2),
      mode: payment.mode,
      particulars: payment.particulars,
      recordedAt: payment.recordedAt.toISOString(),
    })),
  };
}
