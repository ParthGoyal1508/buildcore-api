import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RaBillStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import { rupeesInWords } from '../../../common/rupees-in-words';
import { CompaniesService } from '../../../settings/companies/companies.service';
import { ProjectSourcesRegistry } from '../../portfolio/project-sources.registry';
import { BILLING_ERRORS } from '../billing-error-codes';
import { PaymentAdviceRenderer } from './payment-advice.renderer';

/**
 * The template a payment advice is written from. `{{token}}`s are replaced at runtime from the
 * payment, the bill, the vendor and the company — the same token shape the letters module uses.
 *
 * Kept as data rather than written into the renderer, so the wording is one place to change and
 * both the PDF and the Word copy say the same thing.
 */
export const PAYMENT_ADVICE_TEMPLATE = {
  title: 'PAYMENT ADVICE',
  salutation: 'Dear Sir/Madam,',
  body:
    'We have {{how}} for Rs {{amount}} ({{amountInWords}}) against the below mentioned ' +
    'particulars.',
  footer: 'This is Computer generated advice & does not require any signature',
} as const;

export type PayeeBankField =
  | 'bankName'
  | 'bankBranch'
  | 'bankAccountNumber'
  | 'bankAccountHolderName'
  | 'ifscCode';

/** The payee as the payment dialog shows it, and what the advice would print blank. */
export interface PayeeView {
  vendorId: string | null;
  code: string | null;
  name: string | null;
  bankName: string | null;
  bankBranch: string | null;
  bankAccountNumber: string | null;
  bankAccountHolderName: string | null;
  ifscCode: string | null;
  /** The three the advice cannot do without, where unrecorded. */
  missing: PayeeBankField[];
}

function toPayee(
  vendorId: string | null,
  identity: Omit<PayeeView, 'vendorId' | 'missing'> | null,
): PayeeView {
  const view = {
    vendorId,
    code: identity?.code ?? null,
    name: identity?.name ?? null,
    bankName: identity?.bankName ?? null,
    bankBranch: identity?.bankBranch ?? null,
    bankAccountNumber: identity?.bankAccountNumber ?? null,
    bankAccountHolderName: identity?.bankAccountHolderName ?? null,
    ifscCode: identity?.ifscCode ?? null,
  };
  return {
    ...view,
    missing: (['bankName', 'bankAccountNumber', 'ifscCode'] as const).filter(
      (key) => !view[key],
    ),
  };
}

/** Every figure already formatted — the renderer computes nothing. */
export interface PaymentAdviceView {
  company: {
    name: string;
    address: string | null;
    logo: Buffer | null;
  };
  /** Label/value pairs in the screenshot's order: left column, right column. */
  details: {
    left: [string, string][];
    right: [string, string][];
  };
  salutation: string;
  body: string;
  title: string;
  footer: string;
  rows: {
    particulars: string;
    documentDate: string;
    siteName: string;
    paymentAmount: string;
    tdsAmount: string;
  }[];
  totalAmount: string;
  totalTds: string;
  /** For the file's metadata; pinned so the same advice produced twice is the same bytes. */
  transactionDate: string;
  vendorName: string;
  billNumber: string;
}

/**
 * The payment advice a company sends a subcontractor when it pays a certified bill (2026-10-13).
 *
 * One advice per recorded payment — the payment is where the bank's reference and transaction
 * number are known. Refused on a bill that has not been certified: there is no payment to advise
 * of, and `BillPaymentsService` refuses to record one, so reaching this on an uncertified bill means
 * the bill's certification was undone after the money moved.
 */
@Injectable()
export class PaymentAdviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly companies: CompaniesService,
    private readonly sources: ProjectSourcesRegistry,
    private readonly renderer: PaymentAdviceRenderer,
  ) {}

  async documentFor(
    ctx: RlsContext,
    companyId: string,
    paymentId: string,
    format: 'pdf' | 'docx',
  ): Promise<{ bytes: Buffer; filename: string }> {
    const view = await this.viewFor(ctx, companyId, paymentId);
    const bytes =
      format === 'pdf'
        ? await this.renderer.pdf(view)
        : await this.renderer.docx(view);
    const safe = `${view.vendorName} ${view.billNumber}`
      .replace(/[^A-Za-z0-9 .&-]/g, '')
      .trim();
    return {
      bytes,
      filename: `Payment Advice ${safe} ${view.transactionDate}.${format}`,
    };
  }

  /**
   * Who a bill is paid to, with the bank details the advice will print — read before the payment
   * is recorded, so the person paying sees what is missing while they can still fill it in.
   */
  async payeeFor(
    ctx: RlsContext,
    companyId: string,
    raBillId: string,
  ): Promise<PayeeView> {
    const bill = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.rABill.findFirst({
        where: { id: raBillId },
        select: { workOrder: { select: { partnerId: true } } },
      }),
    );
    if (!bill) throw new NotFoundException('RA bill not found');
    const vendorId = bill.workOrder?.partnerId ?? null;
    const source = this.sources.vendorIdentitySource();
    const identity =
      vendorId && source
        ? await source.getPaymentIdentity(vendorId, companyId)
        : null;
    return toPayee(vendorId, identity);
  }

  /** Fills in the payee's bank details from the bill being paid. */
  async setPayeeBank(
    ctx: RlsContext,
    companyId: string,
    raBillId: string,
    details: Partial<Record<PayeeBankField, string>>,
  ): Promise<PayeeView> {
    const payee = await this.payeeFor(ctx, companyId, raBillId);
    const source = this.sources.vendorIdentitySource();
    if (!payee.vendorId || !source) {
      throw new ConflictException({
        statusCode: 409,
        code: BILLING_ERRORS.paymentBillNotCertified,
        message:
          'This bill’s work order names no subcontractor, so there is no vendor record to ' +
          'hold bank details. Set the subcontractor on the work order first.',
      });
    }
    const identity = await source.setBankDetails(
      payee.vendorId,
      companyId,
      details,
    );
    return toPayee(payee.vendorId, identity);
  }

  async viewFor(
    ctx: RlsContext,
    companyId: string,
    paymentId: string,
  ): Promise<PaymentAdviceView> {
    const payment = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.rABillPayment.findFirst({
        where: { id: paymentId },
        include: {
          raBill: {
            select: {
              billNumber: true,
              billingDate: true,
              status: true,
              project: { select: { name: true } },
              workOrder: { select: { partnerId: true, code: true } },
              package: { select: { periodFrom: true, periodTo: true } },
            },
          },
        },
      }),
    );
    if (!payment) throw new NotFoundException('Payment not found');
    const bill = payment.raBill;
    if (bill.status !== RaBillStatus.approved) {
      throw new ConflictException({
        statusCode: 409,
        code: BILLING_ERRORS.paymentBillNotCertified,
        message:
          `${bill.billNumber} is not certified, so no payment advice can be issued against it. ` +
          'Certify the bill first.',
      });
    }

    const company = await this.companies.getDocumentIdentity(companyId);
    const source = this.sources.vendorIdentitySource();
    const vendor =
      bill.workOrder?.partnerId && source
        ? await source.getPaymentIdentity(bill.workOrder.partnerId, companyId)
        : null;

    const amount = payment.amount.toNumber();
    const tds = payment.tdsAmount.toNumber();
    const transactionDate = payment.paidOn.toISOString().slice(0, 10);
    const words = rupeesInWords(amount);

    const period = bill.package
      ? ` (${dotted(bill.package.periodFrom)} to ${dotted(
          bill.package.periodTo,
        )})`
      : '';

    return {
      company: {
        name: company.name,
        address: company.address,
        logo: company.logo,
      },
      title: PAYMENT_ADVICE_TEMPLATE.title,
      details: {
        left: [
          ['Transaction Date', dotted(payment.paidOn)],
          ['Bank Reference No.', payment.reference ?? ''],
          ['Vendor Code', vendor?.code ?? ''],
          ['Vendor Name', vendor?.name ?? bill.workOrder?.code ?? ''],
        ],
        right: [
          ['Bank Name', vendor?.bankName ?? ''],
          ['IFSC Code', vendor?.ifscCode ?? ''],
          ['Account Number', vendor?.bankAccountNumber ?? ''],
          [
            'Bank Transaction Mode.',
            payment.mode ?? INSTRUMENT_MODE[payment.instrument],
          ],
        ],
      },
      salutation: PAYMENT_ADVICE_TEMPLATE.salutation,
      body: fill(PAYMENT_ADVICE_TEMPLATE.body, {
        how: howPaid(payment.mode, payment.instrument),
        amount: inr(amount),
        amountInWords: words,
      }),
      footer: PAYMENT_ADVICE_TEMPLATE.footer,
      rows: [
        {
          particulars: payment.particulars ?? `${bill.billNumber}${period}`,
          documentDate: dotted(bill.billingDate),
          siteName: bill.project.name,
          paymentAmount: inr(amount),
          tdsAmount: inr(tds),
        },
      ],
      totalAmount: inr(amount),
      totalTds: inr(tds),
      transactionDate,
      vendorName: vendor?.name ?? 'Vendor',
      billNumber: bill.billNumber,
    };
  }
}

/**
 * The covering sentence's verb, by mode. "Initiated a credit through NEFT/RTGS to your account" is
 * the bank wording; a cheque or cash payment saying it would be untrue on the face of the advice.
 */
function howPaid(mode: string | null, instrument: string): string {
  const named = mode ?? INSTRUMENT_MODE[instrument];
  if (named === 'Cash') return 'made a payment to you in cash';
  if (named === 'Cheque') return 'issued a cheque in your favour';
  if (named === 'Adjustment') return 'adjusted an amount in your account';
  return `initiated a credit through ${named} to your account`;
}

/** What a payment recorded without a mode prints as its mode. */
const INSTRUMENT_MODE: Record<string, string> = {
  bank_transfer: 'NEFT/RTGS',
  cheque: 'Cheque',
  cash: 'Cash',
  adjustment: 'Adjustment',
};

/** `{{token}}` replaced from `values`; an unknown token is left visible rather than blanked. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  );
}

/** 18.10.2025 — the date shape the advice is written in. */
function dotted(value: Date): string {
  const iso = value.toISOString().slice(0, 10);
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** 7,54,619.39 — Indian digit grouping, two decimals. */
function inr(value: number): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
