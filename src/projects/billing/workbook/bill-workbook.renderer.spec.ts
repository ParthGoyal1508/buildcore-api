import * as ExcelJS from 'exceljs';
import { readFileSync } from 'fs';
import { join } from 'path';

import { BillWorkbookRenderer } from './bill-workbook.renderer';
import type { BillWorkbookView } from './bill-workbook.types';
// One definition of the client's real bill, shared with the PDF renderer's spec — two copies would
// be two claims about the same document, drifting apart one edit at a time.
import { measurement, party, subcontractor, view } from './bill-view.fixture';
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
