import { Prisma } from '@prisma/client';

import { BoqImportService } from './boq-import.service';
import { BoqWorkbookReader, WorkbookSheet } from './boq-workbook.reader';
import { ImportBatchStore } from './import-batch.store';
import { identifySchedules } from './schedule-block';

/**
 * A Parth Realcon custom schedule, synthetic but the same shape as the client's own (048 Part A):
 * a "BILL OF QUANTITIES" title, a header whose quantity column reads `BOQ.`, numbered headings,
 * and a `Total Amount` row in place of `Total in Figures`.
 */
function sheet(quantityHeading: string): WorkbookSheet {
  const rows: (string | number | null)[][] = [
    ['Name Of Work: Synthetic expressway O&M', null, null, null, null, null],
    ['BOQ', null, null, null, null, null],
    [' BILL OF QUANTITIES ', null, null, null, null, null],
    [
      'ITEM NO',
      'Description of Items',
      'Unit',
      quantityHeading,
      'Rate ',
      'Amount ',
    ],
    [1, 'GROUP-II', null, null, null, null],
    [2, 'SUPPLY, MANPOWER, DRIVER', 'Mon', 60, 19000, 1140000],
    [3, 'HIRE, TOYOTA INNOVA', 'Km', 90000, 12, 1080000],
    [4, 'GROUP-III', null, null, null, null],
    [5, 'REPAIR & MAINTAIN, VEHICLE', 'Mon', 30, 16000, 480000],
    [null, 'Total Amount ', null, null, null, 2700000],
  ];
  return {
    name: 'Abstract',
    rows: rows.map((cells, index) => ({ rowNumber: index + 1, cells })),
  };
}

const reader = (sheets: WorkbookSheet[]) =>
  ({ read: async () => sheets } as unknown as BoqWorkbookReader);

function service(sheets: WorkbookSheet[]) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    bOQTaskItem: { findMany: jest.fn().mockResolvedValue([]) },
    bOQTaskGroup: { count: jest.fn().mockResolvedValue(0) },
    project: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ quotedPercentage: new Prisma.Decimal(0) }),
    },
  };
  return new BoqImportService(
    reader(sheets),
    new ImportBatchStore(),
    {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as never,
    null as never,
  );
}

const CALLER = {
  buffer: Buffer.from(''),
  companyId: 'company-1',
  userId: 'user-1',
  projectId: 'project-1',
  ctx: { isSuperAdmin: false, companyId: 'company-1' },
};

describe('a quantity column headed with the schedule’s name (048 Part A)', () => {
  it.each(['BOQ.', 'BOQ', 'BOQ Qty', 'BOQ Qty.', 'BOQ Quantity'])(
    'reads "%s" as the quantity heading',
    (heading) => {
      const [schedule] = identifySchedules([sheet(heading)]);
      expect(schedule.headerRowNumber).toBe(4);
      expect(schedule.columns.quantity).toBe(3);
    },
  );

  it('does not take a lone "BOQ" title row for a header', () => {
    // Row 2 reads just "BOQ". It names no description, unit or rate, so the header is row 4.
    const [schedule] = identifySchedules([sheet('BOQ.')]);
    expect(schedule.headerRowNumber).toBe(4);
  });

  it('does not take a "BOQ No." column for the quantity', () => {
    const shape = sheet('Qty');
    shape.rows[3].cells[0] = 'BOQ No.';
    const [schedule] = identifySchedules([shape]);
    expect(schedule.columns.quantity).toBe(3);
  });

  it('imports the lines and reconciles against "Total Amount"', async () => {
    const report = await service([sheet('BOQ.')]).validate(CALLER);
    expect(report.lines).toBe(3);
    expect(report.groups).toBe(2);
    expect(report.totals.scheduleDerived).toBe('2700000.00');
    expect(report.totals.scheduleStated).toBe('2700000.00');
    expect(report.confirmable).toBe(true);
    // Read as the schedule's own total, and still not imported as a line.
    expect(report.excludedRows.map((row) => row.description)).toEqual([
      'Total Amount',
    ]);
  });
});
