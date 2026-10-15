import type { WorkbookHeader } from './bill-workbook.types';
import { printDate } from './print-format';

type Pair = [string, string | null];

/**
 * The bill header as two columns of label/value pairs, **in the direction's own vocabulary**
 * (2026-10-13).
 *
 * One definition for the workbook, the PDF and the Word document. Every one of them printed
 * "Name of Sub-Contractor" and "Vendor Code" on a bill to a government client, where the client's
 * own payment abstract heads the page with the authority, the name of work, the contract number and
 * the bidder.
 */
export function headerPairs(header: WorkbookHeader): [Pair[], Pair[]] {
  const period = `${printDate(header.periodFrom)} to ${printDate(
    header.periodTo,
  )}`;
  const billDate = printDate(header.billDate);
  if (header.direction === 'to_client') {
    return [
      [
        ['Authority', header.issuer.name],
        ['Name of Work', header.natureOfWork ?? header.projectName],
        ['Contract No.', header.externalWorkOrderNo],
        ['Bidder Name', header.receiver.name],
        ['Bill Period', period],
      ],
      [
        ['RA Bill', header.billLabel],
        ['Bill Date', billDate],
        ['Client GSTIN', header.issuer.gstin],
        ['Contractor GSTIN', header.receiver.gstin],
        ['Contractor PAN', header.receiver.pan],
      ],
    ];
  }
  return [
    [
      ['Company Name', header.issuer.name],
      ['Name of Sub-Contractor', header.receiver.name],
      ['Nature of Work', header.natureOfWork],
      ['Location', header.location],
      ['Bill Period', period],
      ['Vendor Code', header.receiver.code],
    ],
    [
      ['Work Order No.', header.externalWorkOrderNo],
      ['Bill No.', header.externalBillNo ?? header.billLabel],
      ['Bill Date', billDate],
      ['Vendor GSTIN', header.receiver.gstin],
      ['Vendor PAN', header.receiver.pan],
      ['Company GSTIN', header.issuer.gstin],
    ],
  ];
}
