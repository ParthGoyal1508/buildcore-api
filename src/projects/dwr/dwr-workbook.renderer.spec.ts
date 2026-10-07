import * as ExcelJS from 'exceljs';

import type { DwrWorkbookView } from './dwr-workbook.renderer';
import { DwrWorkbookRenderer, sheetNameFor } from './dwr-workbook.renderer';

/**
 * The daily report as the client's printable form (028 FR-022, task T055).
 *
 * ## Vacuity note, carried from the plan
 *
 * _Asserting the download returned bytes proves a response, not a document._ A renderer that wrote
 * an empty workbook, or one that put every line's quantity in the wrong column, returns bytes of
 * exactly the same kind as a correct one — and the person who finds out is the client reading the
 * form. So every assertion here **reads the produced file back** with exceljs and checks the cell a
 * reader would look at.
 *
 * The one that matters most is the quantity landing under `Quantity` rather than merely appearing
 * somewhere: a figure in the wrong column is the defect this format is most exposed to, because
 * fifteen columns of a form all look alike at a glance.
 */

function view(overrides: Partial<DwrWorkbookView> = {}): DwrWorkbookView {
  return {
    companyName: 'Parth Realcon Private Limited',
    projectName: 'Medshi to Washim',
    projectCode: 'PRPL-PRJ-0004',
    clientName: 'National Highways Authority of India',
    dprNumber: 'PRPL-PRJ-0004-DPR-0012',
    workDate: '2026-10-05',
    weather: 'clear',
    status: 'submitted',
    recordedByName: 'Rohit Deshmukh',
    submittedByName: 'Anita Kulkarni',
    workerCount: 42,
    machineryCount: 6,
    location: 'KM 71.200 to KM 71.450',
    description: 'Grass cutting on the RHS shoulder, both carriageways.',
    lines: [
      {
        srNo: 1,
        boqNo: '12.01',
        activity: 'Unwanted vegetation / grass cutting & removal',
        details: 'ROW grass cleaning',
        chainageFrom: '71.200',
        chainageTo: '71.450',
        unit: 'KM',
        side: 'RHS',
        length: '0.250',
        width: '1.000',
        depth: '1.000',
        quantity: '0.250',
        target: '0.900',
        engineerName: 'S. Patil',
        remarks: 'Chemical spray pending',
      },
      {
        srNo: 2,
        boqNo: null,
        activity: 'Standby for authority inspection',
        details: null,
        chainageFrom: null,
        chainageTo: null,
        unit: null,
        side: null,
        // A presence-paid line: null rather than 1, so the form does not read as a measured metre.
        length: null,
        width: null,
        depth: null,
        quantity: '1.000',
        target: null,
        engineerName: null,
        remarks: null,
      },
    ],
    ...overrides,
  };
}

/** Reads a rendered workbook back, as a reader's spreadsheet would open it. */
async function readBack(bytes: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return workbook;
}

/** The row whose first cell is `label`, as a plain array of its values. */
function rowLabelled(sheet: ExcelJS.Worksheet, label: string): unknown[] {
  let found: unknown[] = [];
  sheet.eachRow((row) => {
    if (String(row.getCell(1).value ?? '').trim() === label) {
      found = (row.values as unknown[]).slice(1);
    }
  });
  return found;
}

describe('the printable daily form', () => {
  it('names its sheet the way the client names theirs', async () => {
    const workbook = await readBack(
      await new DwrWorkbookRenderer().render(view()),
    );

    // `05.10.2026`, not "Sheet1". A folder of thirty-one sheets called Sheet1..Sheet31 is a folder
    // somebody has to open every tab of to find a day.
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      '05.10.2026',
    ]);
    expect(sheetNameFor('2026-10-05')).toBe('05.10.2026');
  });

  it('carries both identities on the form, by name', async () => {
    // FR-024. Both, because on a report returned for correction they are different people — and
    // this fixture makes them different precisely so a renderer printing one twice fails.
    const sheet = (
      await readBack(await new DwrWorkbookRenderer().render(view()))
    ).worksheets[0];

    expect(rowLabelled(sheet, 'Recorded by')[1]).toBe('Rohit Deshmukh');
    expect(rowLabelled(sheet, 'Submitted by')[1]).toBe('Anita Kulkarni');
  });

  it('puts the measured quantity under Quantity, in the measured line’s row', async () => {
    const sheet = (
      await readBack(await new DwrWorkbookRenderer().render(view()))
    ).worksheets[0];

    // The column header row, found rather than assumed: a test that hardcoded row 17 would start
    // passing for the wrong reason the first time a header pair was added above it.
    let headerRow = 0;
    sheet.eachRow((row, number) => {
      if (String(row.getCell(1).value ?? '').trim() === 'Sr. No.') {
        headerRow = number;
      }
    });
    expect(headerRow).toBeGreaterThan(0);

    const headers = (sheet.getRow(headerRow).values as unknown[]).slice(
      1,
    ) as string[];
    const quantityColumn = headers.indexOf('Quantity') + 1;
    const boqColumn = headers.indexOf('BOQ No.') + 1;
    const widthColumn = headers.indexOf('Width') + 1;
    expect(quantityColumn).toBeGreaterThan(0);

    const measured = sheet.getRow(headerRow + 1);
    expect(measured.getCell(boqColumn).value).toBe('12.01');
    // **The assertion the vacuity note is about.** Not "the figure is in the file" — the figure is
    // in the column a reader reads quantities from.
    expect(measured.getCell(quantityColumn).value).toBe('0.250');
    expect(measured.getCell(widthColumn).value).toBe('1.000');

    const presence = sheet.getRow(headerRow + 2);
    expect(presence.getCell(quantityColumn).value).toBe('1.000');
    // Blank, not 1. On this form a 1 in the Width column reads as a measured metre.
    expect(presence.getCell(widthColumn).value ?? '').toBe('');
    expect(presence.getCell(boqColumn).value ?? '').toBe('');
  });

  it('says so rather than printing an empty table when nothing was measured', async () => {
    const sheet = (
      await readBack(
        await new DwrWorkbookRenderer().render(view({ lines: [] })),
      )
    ).worksheets[0];

    const text = JSON.stringify(sheet.getSheetValues() as unknown as unknown[]);
    // An empty table and a table that failed to render look identical to a reader.
    expect(text).toContain('No work measured on this report.');
  });

  it('is identical byte for byte when produced twice', async () => {
    // The timestamp is pinned to the work date rather than the clock, like both bill renderers. A
    // form emailed twice should differ in nothing, metadata included.
    const renderer = new DwrWorkbookRenderer();
    const first = await renderer.render(view());
    const second = await renderer.render(view());

    expect(first.equals(second)).toBe(true);
  });

  it('takes no constructor argument, so it cannot query', () => {
    // The same assertion both bill renderers carry: a renderer that could query could recompute,
    // and the form would then be free to disagree with the screen.
    expect(DwrWorkbookRenderer.length).toBe(0);
  });
});
