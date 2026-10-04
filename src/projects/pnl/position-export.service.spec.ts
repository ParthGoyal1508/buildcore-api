import {
  HIDDEN_CELL,
  POSITION_EXPORT_COLUMNS,
  UNAVAILABLE_CELL,
  cell,
  documentTitle,
  filenameStem,
  positionReport,
  type PositionExportInput,
} from './position-export.service';
import {
  renderReportExcel,
  renderReportPdf,
} from '../../dashboard/reports/export/export-renderer';

/**
 * The monthly position export (018 FR-011a, plan D14 — tasks T068 to T072).
 *
 * The two assertions that earn the phase: the document carries the screen's figures **unchanged**
 * (SC-008, T070), and two exports of the same month taken either side of a correction are tellable
 * apart (T071). Both are made against `positionReport`, which is pure, so neither depends on being
 * able to read a PDF back.
 */

const view: PositionExportInput = {
  projectName: 'Ring Road',
  period: '2026-09',
  revenueMonthly: 1250000.5,
  revenueCumulative: 8400000.75,
  revenueNote: 'Billed gross, before retention, on bills that have left draft.',
  // FR-015a: part of the revenue above, never an addition to it.
  revenueFromVariationsMonthly: 150000.5,
  revenueFromVariationsCumulative: 400000.75,
  categories: [
    {
      category: 'labour',
      monthly: 212356.45,
      cumulative: 1890400.1,
      budget: 2500000,
      variance: 609599.9,
    },
    {
      category: 'subcontractors',
      monthly: 480000,
      cumulative: 3600000,
      budget: null,
      variance: null,
    },
    {
      category: 'materials',
      monthly: 0,
      cumulative: 0,
      budget: 1000000,
      variance: 1000000,
    },
  ],
  costMonthly: 692356.45,
  costCumulative: 5490400.1,
  marginCumulative: 2909600.65,
  unavailableCategories: ['materials'],
};

const rowFor = (
  report: { rows: Record<string, unknown>[] },
  label: string,
): Record<string, unknown> => {
  const row = report.rows.find((r) => r.line === label);
  if (!row) throw new Error(`no row labelled "${label}"`);
  return row;
};

describe('the exported figures are the screen’s figures (T070, SC-008)', () => {
  const report = positionReport(view, new Date('2026-10-02T14:05:33.421Z'));

  it('carries revenue exactly, not approximately', () => {
    expect(rowFor(report, 'Revenue billed')).toEqual({
      line: 'Revenue billed',
      monthly: '1250000.50',
      cumulative: '8400000.75',
    });
  });

  it('carries every category figure the P&L produced', () => {
    expect(rowFor(report, 'Labour')).toEqual({
      line: 'Labour',
      monthly: '212356.45',
      cumulative: '1890400.10',
      budget: '2500000.00',
      variance: '609599.90',
    });
  });

  it('carries the totals and the margin', () => {
    expect(rowFor(report, 'Total cost').cumulative).toBe('5490400.10');
    expect(rowFor(report, 'Margin').cumulative).toBe('2909600.65');
  });

  it('keeps the trailing paisa, which is where a document starts disagreeing with a screen', () => {
    // 1890400.1 must read as 1890400.10, not 1890400.1 — a column where some cells carry two
    // places and some carry one is the first thing a client queries, and the answer is always
    // "the system is fine, the export is odd".
    expect(cell(1890400.1)).toBe('1890400.10');
    expect(cell(1250000.5)).toBe('1250000.50');
    expect(cell(609599.9)).toBe('609599.90');
  });

  it('states the revenue basis, so the document cannot be misread as cash received', () => {
    expect(
      report.rows.some(
        (row) =>
          typeof row.line === 'string' &&
          row.line.startsWith('Revenue basis:') &&
          row.line.includes('before retention'),
      ),
    ).toBe(true);
  });
});

describe('the document says what it covers and when it was made (T069, D14)', () => {
  const producedAt = new Date('2026-10-02T14:05:33.421Z');
  const report = positionReport(view, producedAt);

  it('carries the project, the month and the production instant', () => {
    expect(report.rows[0].line).toBe('Project: Ring Road');
    expect(report.rows[1].line).toBe('Month: 2026-09');
    expect(report.rows[2].line).toBe('Produced at: 2026-10-02T14:05:33.421Z');
  });

  it('puts the production instant in the filename too', () => {
    expect(filenameStem(view, producedAt)).toBe(
      'position-ring-road-2026-09-produced-2026-10-02T14-05-33-421Z',
    );
  });

  it('keeps the title legal as a worksheet name', () => {
    // `renderReportExcel` uses the title as the worksheet name, and the format rejects
    // : / \ * ? [ ] in one. A colon here would fail at render time, in production, on a
    // client-facing document.
    expect(documentTitle(view)).toBe('Ring Road monthly position 2026-09');
    expect(documentTitle(view)).not.toMatch(/[:/\\*?[\]]/);
  });
});

describe('two exports either side of a correction are tellable apart (T071)', () => {
  it('differ in production instant and in figures', () => {
    const before = positionReport(view, new Date('2026-10-02T14:05:33.421Z'));

    // A payment sheet is reopened, a day is corrected, and it is re-approved — the spec's edge case.
    const corrected: PositionExportInput = {
      ...view,
      categories: view.categories.map((row) =>
        row.category === 'labour'
          ? { ...row, monthly: 206756.45, cumulative: 1884800.1 }
          : row,
      ),
      costMonthly: 686756.45,
      costCumulative: 5484800.1,
      marginCumulative: 2915200.65,
    };
    const after = positionReport(
      corrected,
      new Date('2026-10-02T16:41:02.004Z'),
    );

    expect(before.rows[2].line).not.toBe(after.rows[2].line);
    expect(rowFor(before, 'Labour').monthly).toBe('212356.45');
    expect(rowFor(after, 'Labour').monthly).toBe('206756.45');
    expect(rowFor(before, 'Margin').cumulative).not.toBe(
      rowFor(after, 'Margin').cumulative,
    );
  });

  it('gives them different filenames, so one cannot overwrite the other', () => {
    expect(filenameStem(view, new Date('2026-10-02T14:05:33.421Z'))).not.toBe(
      filenameStem(view, new Date('2026-10-02T16:41:02.004Z')),
    );
  });
});

describe('an absent figure is marked absent, never zeroed (T072, FR-010/FR-015)', () => {
  it('names an unavailable category rather than exporting its zero', () => {
    const report = positionReport(view, new Date());
    const materials = rowFor(report, 'Materials');

    // The P&L handed over 0 for materials *and* listed it as unavailable. Exporting the zero
    // would understate the project by whatever was actually spent, with nothing saying so.
    expect(materials.monthly).toBe(UNAVAILABLE_CELL);
    expect(materials.cumulative).toBe(UNAVAILABLE_CELL);
  });

  it('explains the exclusion on the face of the document', () => {
    const report = positionReport(view, new Date());

    expect(
      report.rows.some(
        (row) =>
          typeof row.line === 'string' &&
          row.line.includes('Not available, and therefore excluded') &&
          row.line.includes('Materials'),
      ),
    ).toBe(true);
  });

  it('exports a hidden cash figure as hidden, not as nothing', () => {
    // What `hideCash` leaves behind: the figure nulled, the row otherwise intact.
    const hidden: PositionExportInput = {
      ...view,
      categories: view.categories.map((row) =>
        row.category === 'labour'
          ? { ...row, monthly: null, cumulative: null }
          : row,
      ),
    };

    const labour = rowFor(positionReport(hidden, new Date()), 'Labour');

    expect(labour.monthly).toBe(HIDDEN_CELL);
    expect(labour.cumulative).toBe(HIDDEN_CELL);
    expect(labour.monthly).not.toBe('0.00');
  });

  it('never renders an absent figure as an empty cell', () => {
    // An empty cell in a column of numbers is a zero to every spreadsheet that sums it, which is
    // the failure this whole rule exists to prevent.
    expect(cell(null)).not.toBe('');
    expect(cell(undefined)).not.toBe('');
    expect(cell(0, true)).not.toBe('');
    expect(cell(0)).toBe('0.00');
  });
});

describe('it uses the repository’s existing renderer (T068)', () => {
  it('produces a readable xlsx from the same ReportData the dashboard uses', async () => {
    const report = positionReport(view, new Date('2026-10-02T14:05:33.421Z'));
    const buffer = await renderReportExcel(documentTitle(view), report);

    // The xlsx magic bytes — it is a real workbook, not an empty buffer.
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it('produces a real PDF', async () => {
    const report = positionReport(view, new Date('2026-10-02T14:05:33.421Z'));
    const buffer = await renderReportPdf(documentTitle(view), report);

    expect(buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('declares the columns a reader of the screen would expect', () => {
    expect(POSITION_EXPORT_COLUMNS.map((column) => column.key)).toEqual([
      'line',
      'monthly',
      'cumulative',
      'budget',
      'variance',
    ]);
  });
});
