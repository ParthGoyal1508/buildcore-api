import type {
  BillWorkbookView,
  WorkbookMeasurementSheet,
  WorkbookParty,
} from './bill-workbook.types';

/**
 * The client's real RA-12, as a view — **one definition, read by every renderer's tests**.
 *
 * Lifted out of `bill-workbook.renderer.spec.ts` when the PDF renderer arrived (025 FR-042). Two
 * copies of this fixture would be two claims about what the client's bill says, drifting apart one
 * edit at a time, and the two documents they test are supposed to be the same bill.
 *
 * The figures are the real ones: 18,41,686 this month, CGST and SGST of 1,65,752 each, retention
 * 92,084, TDS 36,834, payable 11,39,971. Reproducing a real document is what catches a rate applied
 * to the wrong base — asserting percentages would agree with itself.
 */

export const party = (over: Partial<WorkbookParty> = {}): WorkbookParty => ({
  name: 'H.G. Infra Engineering Ltd',
  gstin: '08AABCH2668B1ZU',
  pan: 'AABCH2668B',
  state: 'Rajasthan',
  address: 'Jaipur',
  code: null,
  ...over,
});

export const subcontractor = party({
  name: 'Parth Realcon Private Limited',
  gstin: '08AAMCP8659H1ZO',
  pan: 'AAMCP8659H',
  code: '1504373',
});

export function measurement(index: number): WorkbookMeasurementSheet {
  return {
    scheduleLineId: `line-${index}`,
    srNo: index,
    boqNo: `30.${index * 10}`,
    description: 'Ambulance with paramedical staff, all complete',
    unit: 'Month',
    history: [
      {
        month: 'January 2026',
        period: 'From 21.12.2025 to 20.01.2026',
        quantity: '0.700',
        remarks:
          '30 % deduction Shoulder Slope, Supervisor Labour, Staff Not availeble & ROW Not Cleaned',
        billLabel: 'RA-12',
        overClaimed: false,
      },
    ],
    dailyRecord: [
      {
        date: '2026-01-19',
        openingReading: '12000.000',
        closingReading: '12080.000',
        totalRun: '80.000',
        remarks: 'Accident Attend at CH.239+350 RHS',
        missing: false,
      },
      {
        date: '2026-01-20',
        openingReading: null,
        closingReading: null,
        totalRun: null,
        remarks: null,
        missing: true,
      },
    ],
    footer: {
      thisBillQty: '0.700',
      uptoPreviousQty: '1.100',
      uptoDateQty: '1.800',
    },
  };
}

export function view(over: Partial<BillWorkbookView> = {}): BillWorkbookView {
  return {
    header: {
      issuer: party(),
      receiver: subcontractor,
      projectName: 'O&M-DV Pkg 08',
      natureOfWork: 'O&M of Highway for 1st Year',
      location: 'O&M-DV Pkg 08',
      externalWorkOrderNo: '16014256',
      externalBillNo: '0016014256/12',
      billLabel: 'RA-12',
      periodFrom: '2025-12-21',
      periodTo: '2026-01-20',
      billDate: '2026-02-03',
      missingFields: [],
    },
    checkList: {
      rows: [
        {
          position: 1,
          text: 'Is cumulative measurement including this bill, Attached?',
          answer: 'yes',
        },
        {
          position: 2,
          text: 'Is material issued and reciept till this bills, Attached?',
          answer: 'not_required',
        },
        {
          position: 3,
          text: 'Is RMC dispached detail till this bills, Attached?',
          answer: 'no',
        },
        { position: 4, text: 'Is BBS for this bill, Attached?', answer: null },
        {
          position: 5,
          text: 'Is Reconcilication for RMC, STEEL, Shuttering Material and others, Attached?',
          answer: null,
        },
        {
          position: 6,
          text: 'Is Debit Note duly review by Planning dept in line with the Scope of Work, Attached?',
          answer: null,
        },
      ],
      footer: 'Please Note: compliances of the above said check list points…',
      signatories: ['Prepared by', 'Checked By'],
    },
    abstract: {
      blocks: [
        {
          title: 'A. WORK',
          rows: [
            {
              label: 'Work Done amount',
              uptoDate: '31559159',
              uptoPrevious: '29717473',
              thisMonth: '1841686',
            },
            {
              label: 'CGST',
              uptoDate: '2840324',
              uptoPrevious: '2674573',
              thisMonth: '165752',
            },
            {
              label: 'Total Amount (A)',
              uptoDate: '37239807',
              uptoPrevious: '35066618',
              thisMonth: '2173189',
              isTotal: true,
            },
          ],
        },
        {
          title: 'C. DEDUCTIONS',
          rows: [
            {
              label: 'Retention money @ 5%',
              uptoDate: '1577958',
              uptoPrevious: '1485874',
              thisMonth: '92084',
            },
            {
              label: 'Performance Security at 3% of WO Amount',
              uptoDate: '1057832',
              uptoPrevious: '1057832',
              thisMonth: '0',
              // Blank this month, cumulative preserved (FR-020a).
              fullyRecovered: true,
            },
          ],
        },
      ],
      payable: {
        label: 'AMOUNT PAYABLE',
        uptoDate: '30026515',
        uptoPrevious: '28886544',
        thisMonth: '1139971',
      },
      netPayable: {
        label: 'NET PAYBLE AMOUNT',
        uptoDate: '30026515',
        uptoPrevious: '28886544',
        thisMonth: '1139971',
      },
      taxBasis: 'intra_state',
      taxBasisSource: 'derived_from_gstin',
    },
    schedule: {
      lines: [
        {
          srNo: 1,
          boqNo: '30.10',
          description:
            'Ambulance with paramedical staff, all complete in the subcontractor’s scope.',
          unit: 'Month',
          scopeQty: '12.000',
          rate: '150000.00',
          scopeAmount: '1800000.00',
          balanceQty: '-2.000',
          qtyUptoDate: '14.000',
          qtyUptoPrevious: '13.300',
          qtyThisBill: '0.700',
          amountUptoDate: '2100000.00',
          amountUptoPrevious: '1995000.00',
          amountThisBill: '105000.00',
        },
      ],
      totals: {
        scopeAmount: '71425152.00',
        amountUptoDate: '31559159.00',
        amountUptoPrevious: '29717473.00',
        amountThisBill: '1841686.00',
      },
    },
    measurementSheets: [measurement(1)],
    debitRegister: {
      groups: [
        {
          heading: 'Debit against the ATMS Equipment Missing at site',
          rows: [
            {
              srNo: 1,
              description: 'PTZ camera missing',
              location: 'KM.226 LHS',
              nos: '1.000',
              length: null,
              width: null,
              quantity: '1.000',
              rate: '125000.00',
              unit: 'Nos',
              amount: '125000.00',
              amountWithTax: '147500.00',
              remark: 'RA-12',
            },
          ],
        },
      ],
      total: '147500.00',
    },
    ...over,
  };
}
