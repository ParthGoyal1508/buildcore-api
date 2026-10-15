import { HireBillBasis, MeterType } from '@prisma/client';

import {
  type FormCompany,
  type FormDocument,
  type FormRow,
  dotDate,
  inr,
  qty,
  reading,
} from '../../common/form-document';
import { rupeesFirstInWords } from '../../common/rupees-in-words';
import type { VendorParticulars } from '../../partners/partners.service';
import type { HireBillRow } from './hire-bills.service';

/**
 * The vehicle hiring bill as the client's "VEHICLE HIRING BILL" format lays it out (2026-10-15):
 * Company | Sub Contractor Details | Bill Details; the vehicle and hiring charges; the operating
 * details (monthly rent, average, start and ending reading, distance, diesel given and the diesel
 * the run should have taken); the amount summary; the net after deduction, in figures and in words;
 * the supplier's bank and the authorisation; and the sub-contractor's signature.
 *
 * Everything the format highlights — the charge line, the vehicle, the period, the days, the rate
 * and amount — comes from the bill; the headings and labels are fixed.
 */
export function buildHireBillForm(
  bill: HireBillRow,
  company: FormCompany,
  vendor: VendorParticulars | null,
): FormDocument {
  const km = bill.meterType === MeterType.km;
  const unit = km ? 'Km.' : 'Hrs.';
  const vehicle = bill.registrationNo ?? bill.equipmentCode;
  const monthly = bill.basis === HireBillBasis.monthly;
  const from = bill.billingPeriodFrom;
  const to = bill.billingPeriodTo;
  const run =
    bill.startReading !== null && bill.endReading !== null
      ? Math.max(0, bill.endReading - bill.startReading)
      : bill.logbookHours;

  const supplierLines = [
    vendor?.name ?? bill.vendorName,
    ...(vendor?.address ? [vendor.address] : []),
    [
      vendor?.pan ? `PAN: ${vendor.pan}` : null,
      vendor?.phone ? `Mob.: ${vendor.phone}` : null,
    ]
      .filter(Boolean)
      .join(' | '),
    ...(vendor?.gstin ? [`GSTIN: ${vendor.gstin}`] : []),
  ].filter(Boolean);

  const charge: FormRow = monthly
    ? [
        '1',
        bill.description ?? `Monthly vehicle rent – ${bill.equipmentName}`,
        vehicle,
        `${dotDate(from)}–${dotDate(to)}`,
        `${bill.periodDays ?? ''} days`,
        inr(bill.monthlyRate),
        inr(bill.grossAmount),
      ]
    : [
        '1',
        bill.description ?? `Hire charges – ${bill.equipmentName}`,
        vehicle,
        `${dotDate(from)}–${dotDate(to)}`,
        `${qty(bill.billedHours, 2)} ${km ? 'km' : 'hrs'}`,
        inr(bill.rate),
        inr(bill.grossAmount),
      ];

  const summary: FormRow[] = [
    ['Total Amount', inr(bill.grossAmount)],
    [
      { text: 'Gross Amount', bold: true },
      { text: inr(bill.grossAmount), bold: true },
    ],
    [
      { text: 'Deduction Amount', bold: true },
      { text: inr(bill.deductionAmount), bold: true },
    ],
    ...(bill.tdsAmount > 0
      ? [
          [
            {
              text: `TDS${
                bill.tdsRate !== null ? ` @ ${qty(bill.tdsRate, 2)}%` : ''
              }`,
              bold: true,
            },
            { text: inr(bill.tdsAmount), bold: true },
          ] as FormRow,
        ]
      : []),
    ...(bill.fuelRecoveryTotal > 0
      ? [
          [
            { text: 'Fuel Recovery', bold: true },
            { text: inr(bill.fuelRecoveryTotal), bold: true },
          ] as FormRow,
        ]
      : []),
    [
      { text: 'Debit / Hold Amount', bold: true },
      { text: bill.holdAmount ? inr(bill.holdAmount) : '', bold: true },
    ],
  ];

  const bank = vendor?.bank;
  return {
    company,
    title: 'VEHICLE HIRING BILL',
    accent: 'amber',
    sheetName: 'Vehicle Hiring Bill',
    footer: `Vehicle hiring bill · ${vehicle} · ${dotDate(from)}–${dotDate(
      to,
    )}`,
    blocks: [
      {
        kind: 'panels',
        panels: [
          {
            title: 'Company',
            lines: [
              company.name,
              ...(company.address
                ? [`Registered Address: - ${company.address}`]
                : []),
            ],
          },
          { title: 'Sub Contractor Details', lines: supplierLines },
          {
            title: 'Bill Details',
            lines: [
              `Date: ${dotDate(bill.billDate ?? bill.createdAt)}`,
              `Reference Invoice No.: ${bill.invoiceNo ?? ''}`,
              `Tax Invoice Ref.: ${bill.taxInvoiceRef ?? ''}`,
              `Tax Invoice Date: ${dotDate(bill.taxInvoiceDate)}`,
              ...(bill.hireOrderCode
                ? [`Work Order No.: ${bill.hireOrderCode}`]
                : []),
              '',
              `Vendor Code:- ${vendor?.code ?? ''}`,
            ],
          },
        ],
      },
      { kind: 'heading', text: 'Vehicle and Hiring Charges' },
      {
        kind: 'table',
        columns: [
          { label: 'Sr.', width: 4, align: 'center' },
          { label: 'Description', width: 22 },
          { label: 'Vehicle No.', width: 11 },
          { label: 'Period', width: 14, align: 'center' },
          { label: 'Qty.', width: 7, align: 'center' },
          {
            label: monthly ? 'Monthly Rate' : 'Rate',
            width: 10,
            align: 'right',
          },
          { label: 'Amount', width: 11, align: 'right' },
        ],
        rows: [charge],
      },
      { kind: 'heading', text: `Operating Details (Vehicle ${vehicle})` },
      {
        kind: 'table',
        columns: [
          {
            label: monthly ? 'Monthly Rent' : 'Rate',
            width: 11,
            align: 'right',
          },
          { label: 'Average', width: 8, align: 'right' },
          { label: `Start ${unit}`, width: 10, align: 'right' },
          { label: `Ending ${unit}`, width: 10, align: 'right' },
          { label: km ? 'Distance' : 'Hours', width: 9, align: 'right' },
          { label: 'Diesel Given', width: 10, align: 'right' },
          { label: 'Actual Diesel', width: 10, align: 'right' },
        ],
        rows: [
          [
            inr(monthly ? bill.monthlyRate : bill.rate, 0),
            bill.agreedAverage === null
              ? ''
              : `${qty(bill.agreedAverage, 2)} ${km ? 'km/l' : 'l/hr'}`,
            reading(bill.startReading),
            reading(bill.endReading),
            `${qty(run, 2)} ${km ? 'km' : 'hrs'}`,
            bill.dieselGiven === null ? '' : `${qty(bill.dieselGiven, 2)} Ltr`,
            bill.actualDiesel === null
              ? ''
              : `${qty(bill.actualDiesel, 2)} Ltr`,
          ],
        ],
      },
      { kind: 'heading', text: 'Amount Summary' },
      {
        kind: 'table',
        columns: [
          { label: 'Particulars', width: 20 },
          { label: 'Amount', width: 12, align: 'right' },
        ],
        rows: summary,
      },
      {
        kind: 'amount',
        label: 'Net amount after deduction:',
        value: inr(bill.netPayable),
      },
      {
        kind: 'paragraph',
        text: [
          { text: 'Amount in words: ', bold: true },
          { text: rupeesFirstInWords(Math.round(bill.netPayable * 100) / 100) },
        ],
      },
      {
        kind: 'panels',
        panels: [
          {
            title: `Bank Details (${vendor?.name ?? bill.vendorName})`,
            lines: bank
              ? [
                  bank.name ?? '',
                  `A/c No.: ${bank.accountNumber}`,
                  `IFSC: ${bank.ifsc ?? ''}`,
                  ...(bank.branch ? [`Branch: ${bank.branch}`] : []),
                ].filter(Boolean)
              : ['Not on file'],
          },
          {
            title: 'Authorisation',
            lines: [
              '',
              'Project Manager Signature: __________________',
              '',
              '',
              'Site In charge Signatory: __________________',
            ],
          },
        ],
      },
      {
        kind: 'signatures',
        boxed: true,
        items: [
          {
            caption: 'Sub Contractor Signatory',
            lines: [
              '',
              'Signature: __________________',
              '',
              'Date: __________________',
            ],
          },
        ],
      },
    ],
  };
}
