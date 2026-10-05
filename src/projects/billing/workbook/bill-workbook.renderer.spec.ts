import * as ExcelJS from 'exceljs';
import { readFileSync } from 'fs';
import { join } from 'path';

import { BillWorkbookRenderer } from './bill-workbook.renderer';
import type {
  BillWorkbookView,
  WorkbookMeasurementSheet,
  WorkbookParty,
} from './bill-workbook.types';
import {
  InvalidSheetNameError,
  assertSheetName,
  measurementSheetName,
} from './sheet-names';

/**
 * The workbook (023 US3, tasks T073a to T078).
 *
 * Four of these are the feature's defence against a document that looks right and is not:
 *
 * - **T073a** — both directions from one renderer, with the party cells exchanged. The user's first
 *   sentence about this feature.
 * - **T074** — the sheet count, asserted as a count *computed from the input*. A workbook with a
 *   missing sheet opens perfectly, and a reviewer paging through 312 measurement sheets does not
 *   notice there are 311.
 * - **T075** — produced twice, identical in every cell.
 * - **T078** — the renderer cannot query, asserted directly, because an absence nothing checks is
 *   an absence somebody adds a constructor parameter to.
 */

const party = (over: Partial<WorkbookParty> = {}): WorkbookParty => ({
  name: 'H.G. Infra Engineering Ltd',
  gstin: '08AABCH2668B1ZU',
  pan: 'AABCH2668B',
  state: 'Rajasthan',
  address: 'Jaipur',
  code: null,
  ...over,
});

const subcontractor = party({
  name: 'Parth Realcon Private Limited',
  gstin: '08AAMCP8659H1ZO',
  pan: 'AAMCP8659H',
  code: '1504373',
});

function measurement(index: number): WorkbookMeasurementSheet {
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

function view(over: Partial<BillWorkbookView> = {}): BillWorkbookView {
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

async function sheetNames(bytes: Buffer): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  return workbook.worksheets.map((sheet) => sheet.name);
}

/** Every cell of every sheet, flattened, so two workbooks can be compared exactly. */
async function allCells(bytes: Buffer): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const out: string[] = [];
  for (const sheet of workbook.worksheets) {
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        out.push(
          `${sheet.name}!${rowNumber}:${colNumber}=${String(cell.value ?? '')}`,
        );
      });
    });
  }
  return out;
}

describe('the sheet count', () => {
  it('equals the number of schedule lines plus the four fixed sheets', async () => {
    // T074, FR-030a. **Asserted as a count computed from the input**, not a number typed here. An
    // assertion over the sheets a workbook contains passes just as happily over a short list — and
    // a workbook with a missing sheet opens perfectly, so nothing else would catch it.
    const renderer = new BillWorkbookRenderer();
    const lines = 40;
    const subject = view({
      measurementSheets: Array.from({ length: lines }, (_, index) =>
        measurement(index + 1),
      ),
    });

    const names = await sheetNames(await renderer.render(subject));

    expect(names).toHaveLength(subject.measurementSheets.length + 4);
    expect(names).toEqual(renderer.sheetNamesFor(subject));
  });

  it('gives a sheet to a line with nothing claimed this period', async () => {
    // FR-030. An item claimed nothing still gets its sheet, with "-" quantities, exactly as the
    // client's own package does — because the absence of a sheet reads as the absence of the item.
    const renderer = new BillWorkbookRenderer();
    const empty = {
      ...measurement(2),
      history: [],
      dailyRecord: [],
      footer: {
        thisBillQty: '0.000',
        uptoPreviousQty: '0.000',
        uptoDateQty: '0.000',
      },
    };

    const names = await sheetNames(
      await renderer.render(
        view({ measurementSheets: [measurement(1), empty] }),
      ),
    );

    expect(names.filter((name) => name.startsWith('M-'))).toEqual([
      'M-001',
      'M-002',
    ]);
  });
});

describe('the five sheet kinds, in the client’s order', () => {
  it('are present and in order', async () => {
    // T077a, FR-024, SC-002. A reviewer finds each figure by where it sits, and a workbook carrying
    // all five in a different order is one they have to search.
    const renderer = new BillWorkbookRenderer();

    const names = await sheetNames(await renderer.render(view()));

    expect(names).toEqual([
      'Check List',
      'Abstract',
      'BOQ Annexure-I',
      'M-001',
      'Debit Note',
    ]);
  });
});

describe('both directions, one renderer', () => {
  it('exchanges the party cells and changes nothing else', async () => {
    // T073a, SC-008, FR-025. The user's own words: "one renderer, two bindings; the two party names
    // are the stated variables." Two renderers would drift apart, and the drift would surface as a
    // government bill that had stopped matching the subcontractor one.
    const renderer = new BillWorkbookRenderer();
    const authority = party({
      name: 'National Highways Authority of India',
      gstin: '07AAAGN0192E1ZL',
      pan: 'AAAGN0192E',
      state: 'Delhi',
      code: null,
    });

    const toSubcontractor = await allCells(
      await renderer.render(
        view({
          header: {
            ...view().header,
            issuer: party(),
            receiver: subcontractor,
          },
        }),
      ),
    );
    const toClient = await allCells(
      await renderer.render(
        view({
          header: { ...view().header, issuer: authority, receiver: party() },
        }),
      ),
    );

    expect(toSubcontractor).toHaveLength(toClient.length);

    const differing = toSubcontractor.filter(
      (cell, index) => cell !== toClient[index],
    );
    // Only party-identifying cells differ. The count is small and every one of them is a name, a
    // registration number, a permanent account number, a state or a vendor code — never a figure.
    expect(differing.length).toBeGreaterThan(0);
    for (const cell of differing) {
      const value = cell.split('=')[1];
      expect(
        [
          'H.G. Infra Engineering Ltd',
          'National Highways Authority of India',
          'Parth Realcon Private Limited',
          '08AABCH2668B1ZU',
          '07AAAGN0192E1ZL',
          '08AAMCP8659H1ZO',
          'AABCH2668B',
          'AAAGN0192E',
          'AAMCP8659H',
          'Rajasthan',
          'Delhi',
          '1504373',
          '',
        ].includes(value),
      ).toBe(true);
    }
  });
});

describe('produced twice', () => {
  it('is identical in every cell', async () => {
    // T075, FR-028, SC-009. **Not byte-for-byte** — a workbook file records when it was written, so
    // two productions are never identical as bytes, and a requirement stated that way could only be
    // met by abandoning it. Every cell is the satisfiable statement, and it is the one that matters:
    // a reproduced bill has to match the copy in the client's file.
    const renderer = new BillWorkbookRenderer();
    const subject = view();

    const first = await allCells(await renderer.render(subject));
    const second = await allCells(await renderer.render(subject));

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(50);
  });
});

describe('what the renderer can reach', () => {
  it('takes no constructor argument, so it cannot query', () => {
    // T078, FR-028, research §6. A renderer that could query could recompute, and the first time it
    // did, a reproduced bill would stop matching the signed one. Asserted directly because an
    // absence nothing checks is an absence somebody adds a parameter to.
    expect(BillWorkbookRenderer.length).toBe(0);

    const source = readFileSync(
      join(__dirname, 'bill-workbook.renderer.ts'),
      'utf8',
    );
    // And it imports nothing that could.
    expect(source).not.toMatch(/from 'nestjs-prisma'/);
    expect(source).not.toMatch(/PrismaService/);
  });
});

describe('long descriptions', () => {
  it('carries a multi-paragraph description whole', async () => {
    // FR-029. The client's own items run to several hundred characters of sub-specification, and a
    // truncated description is a line somebody disputes.
    const renderer = new BillWorkbookRenderer();
    const long = [
      'Providing and maintaining ambulance with paramedical staff.',
      'Including cost for ambulance, diesel, driver, helper, para-medical staff, consumables,',
      'repair and maintenance, all complete in the subcontractor’s scope as directed by the',
      'HGIEL/CLIENT authorized representatives.',
    ].join('\n');

    const bytes = await renderer.render(
      view({
        measurementSheets: [{ ...measurement(1), description: long }],
      }),
    );
    const cells = await allCells(bytes);

    expect(cells.some((cell) => cell.includes(long))).toBe(true);
  });
});

describe('the sheet-naming rule', () => {
  it('refuses a name over the 31-character cap rather than truncating it', () => {
    // FR-024a. A truncated name is a sheet a reader cannot find by the name they were given, and a
    // silent correction is how one of 312 sheets goes missing without the workbook looking wrong.
    expect(() => assertSheetName('A'.repeat(32), new Set())).toThrow(
      InvalidSheetNameError,
    );
  });

  it('refuses a reserved character', () => {
    for (const name of ['30.10/A', 'a:b', 'x[1]', 'p?q', 'm*n', 'c\\d']) {
      expect(() => assertSheetName(name, new Set())).toThrow(
        InvalidSheetNameError,
      );
    }
  });

  it('refuses a duplicate rather than letting one sheet replace another', () => {
    const used = new Set<string>();
    assertSheetName('Abstract', used);

    expect(() => assertSheetName('Abstract', used)).toThrow(
      InvalidSheetNameError,
    );
  });

  it('names 999 measurement sheets without a collision or an overflow', () => {
    // The property that makes a positional name the right answer: a 312-line tender cannot break
    // it, and neither can two items whose descriptions are identical for the first 31 characters.
    const used = new Set<string>();

    for (let position = 1; position <= 999; position += 1) {
      expect(() =>
        assertSheetName(measurementSheetName(position), used),
      ).not.toThrow();
    }
    expect(used.size).toBe(999);
  });
});
