import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { Prisma } from '@prisma/client';

import { BOQ_ERRORS } from './boq-error-codes';
import { BoqImportService, ValidationReport } from './boq-import.service';
import { BoqWorkbookReader, WorkbookSheet } from './boq-workbook.reader';
import { ImportBatchStore } from './import-batch.store';

/**
 * The client's real Rajasthan e-procurement tenders, run through validate end to end (047).
 *
 * **Local only.** `test/fixtures/tenders/` is git-ignored, like `docs/`: the workbooks carry the
 * client's bids. Without them the suite reports one skipped test naming why — never a pass (T094's
 * rule, see `boq-import.service.spec.ts`). Figures were read off each workbook's own footer.
 */
const TENDERS = join(process.cwd(), 'test', 'fixtures', 'tenders');
const PRESENT = existsSync(join(TENDERS, 'NEWAI_SHAHID_SMARAK.xls'));
const file = (name: string) => readFileSync(join(TENDERS, name));

const CALLER = {
  companyId: 'company-1',
  userId: 'user-1',
  projectId: 'project-1',
  ctx: { isSuperAdmin: false, companyId: 'company-1' },
};

/** An empty project holding `projectQuoted`. Validate reads nothing else. */
function emptyProject(projectQuoted = '0') {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    bOQTaskItem: { findMany: jest.fn().mockResolvedValue([]) },
    bOQTaskGroup: { count: jest.fn().mockResolvedValue(0) },
    project: {
      findFirst: jest.fn().mockResolvedValue({
        quotedPercentage: new Prisma.Decimal(projectQuoted),
      }),
    },
  };
  return {
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
}

function service(reader = new BoqWorkbookReader(), projectQuoted = '0') {
  return new BoqImportService(
    reader,
    new ImportBatchStore(),
    emptyProject(projectQuoted),
    null as never,
  );
}

const validate = (
  name: string,
  projectQuoted = '0',
): Promise<ValidationReport> =>
  service(undefined, projectQuoted).validate({
    buffer: file(name),
    ...CALLER,
  });

const schedule = (report: ValidationReport, sheet: string) =>
  report.schedules.find((entry) => entry.sheetName === sheet);

if (!PRESENT) {
  describe('real tenders (047)', () => {
    it.skip('SKIPPED — test/fixtures/tenders/ is not present in this checkout', () =>
      undefined);
  });
}

(PRESENT ? describe : describe.skip)('real tenders (047)', () => {
  describe('NEWAI SHAHID SMARAK — item-rate BoQ1 + percentage BoQ2', () => {
    let report: ValidationReport;
    beforeAll(async () => {
      report = await validate('NEWAI_SHAHID_SMARAK.xls');
    });

    it('reads both schedules, not only the first', () => {
      expect(
        report.schedules.map((s) => [s.sheetName, s.pricingBasis]),
      ).toEqual([
        ['BoQ1', 'item_rate'],
        ['BoQ2', 'percentage'],
      ]);
      expect(schedule(report, 'BoQ1').lines).toBe(2);
      expect(schedule(report, 'BoQ2').lines).toBe(100);
      expect(report.lines).toBe(102);
    });

    it('reconciles each schedule against its own footer', () => {
      const itemRate = schedule(report, 'BoQ1').totals;
      expect(itemRate.scheduleDerived).toBe('488000.00');
      expect(itemRate.scheduleStated).toBe('488000.00');
      // The template writes `Select` beside a 0 on an item-rate sheet's quoted row.
      expect(itemRate.quotedStated).toBeNull();

      const percentage = schedule(report, 'BoQ2');
      expect(percentage.totals.scheduleDerived).toBe('9752823.00');
      expect(percentage.quotedPercentage).toBe('-0.191200');
      expect(percentage.totals.quotedDerived).toBe('7888083.24');
      expect(percentage.totals.quotedStated).toBe('7888083.24');
      expect(report.confirmable).toBe(true);
      expect(report.batchId).not.toBeNull();
    });

    it('takes the quoted percentage from the percentage schedule only', () => {
      expect(report.quotedPercentage).toBe('-0.191200');
      // The whole tender's price: item-rate at its own total, the rest after −19.12%.
      expect(report.totals.quotedDerived).toBe('8376083.24');
    });

    it('asks which quoted percentage to keep when the project holds another', async () => {
      const differs = await validate('NEWAI_SHAHID_SMARAK.xls', '-0.04');
      expect(differs.projectQuotedPercentage).toBe('-0.040000');
      expect(differs.quotedPercentageDiffers).toBe(true);

      const same = await validate('NEWAI_SHAHID_SMARAK.xls', '-0.1912');
      expect(same.quotedPercentageDiffers).toBe(false);
    });
  });

  it('Cyber Thana — item-rate BoQ1 ₹2.59 lakh + percentage BoQ2 at +5.67%', async () => {
    const report = await validate('CYBER_THANA_859032.xls');
    expect(report.lines).toBe(290);
    expect(schedule(report, 'BoQ1')).toMatchObject({
      pricingBasis: 'item_rate',
      lines: 5,
      quotedPercentage: null,
    });
    expect(schedule(report, 'BoQ1').totals.scheduleDerived).toBe('259000.00');
    const boq2 = schedule(report, 'BoQ2');
    expect(boq2).toMatchObject({ pricingBasis: 'percentage', lines: 285 });
    expect(boq2.totals.scheduleDerived).toBe('28910447.90');
    expect(boq2.totals.quotedDerived).toBe('30549670.30');
    expect(report.quotedPercentage).toBe('0.056700');
    expect(report.confirmable).toBe(true);
  });

  it('Mahila Thana — percentage BoQ1 at −4.67% + item-rate BoQ2 ₹7.90 lakh', async () => {
    const report = await validate('MAHILA_THANA_749857.xls');
    expect(report.lines).toBe(235);
    expect(schedule(report, 'BoQ1')).toMatchObject({
      pricingBasis: 'percentage',
      lines: 230,
      quotedPercentage: '-0.046700',
    });
    expect(schedule(report, 'BoQ1').totals.scheduleStated).toBe('27197538.47');
    expect(schedule(report, 'BoQ2')).toMatchObject({
      pricingBasis: 'item_rate',
      lines: 5,
    });
    expect(schedule(report, 'BoQ2').totals.scheduleDerived).toBe('790000.00');
    expect(report.quotedPercentage).toBe('-0.046700');
    expect(report.confirmable).toBe(true);
  });

  describe('STMC KOTA DARAH — "Total amount" and "Add GST @18%" inside the schedule', () => {
    let report: ValidationReport;
    beforeAll(async () => {
      report = await validate('STMC_KOTA_DARAH_832999.xls');
    });

    it('imports neither as a line, and lists both', () => {
      expect(report.lines).toBe(29);
      expect(
        report.excludedRows.map((row) => [
          row.description,
          row.kind,
          row.amount,
        ]),
      ).toEqual([
        ['Total amount', 'total', null],
        ['Add GST @18%', 'tax', '2109163.00'],
      ]);
    });

    it('still reconciles, because the stated total is lines plus the tax it adds', () => {
      const only = report.schedules[0];
      expect(only.totals.scheduleDerived).toBe('11717572.73');
      expect(only.excludedTaxAmount).toBe('2109163.00');
      expect(only.totals.scheduleStated).toBe('13826735.73');
      expect(only.totals.quotedDerived).toBe('13160287.07');
      expect(only.totals.reconciles).toBe(true);
      expect(report.quotedPercentage).toBe('-0.048200');
      expect(report.confirmable).toBe(true);
    });
  });

  it('PHC Ghar — a single percentage schedule imports exactly as before 047', async () => {
    const report = await validate('PHC_GHAR_567935.xls');
    expect(report.schedules).toHaveLength(1);
    expect(report.lines).toBe(131);
    expect(report.quotedPercentage).toBe('-0.126500');
    expect(report.totals.scheduleStated).toBe('16012100.34');
    expect(report.confirmable).toBe(true);
  });

  it('PHC Kaleda — single schedule, −11.04%', async () => {
    const report = await validate('PHC_KALEDA_604833.xls');
    expect(report.lines).toBe(131);
    expect(report.quotedPercentage).toBe('-0.110400');
    expect(report.totals.reconciles).toBe(true);
  });

  it('Bundi Minority Hostel — a file that rounds every line to rupees still reconciles', async () => {
    // Its stated total is ₹1.68 above the paisa-exact sum, because 53 of 134 lines are rounded to
    // whole rupees in the file. That is the file's rounding, not a misread row.
    const report = await validate('BUNDI_HOSTEL_659591.xls');
    expect(report.totals.scheduleDifference).toBe('1.68');
    expect(report.totals.reconciles).toBe(true);
    expect(report.confirmable).toBe(true);
  });

  it('blocks a schedule whose stated total disagrees, and issues no batch', async () => {
    // NEWAI with BoQ2's "Total in Figures" raised by ₹1,000 — the shape of a misread row.
    const real = new BoqWorkbookReader();
    const tampered = {
      read: async (buffer: Buffer): Promise<WorkbookSheet[]> => {
        const sheets = await real.read(buffer);
        for (const row of sheets.find((s) => s.name === 'BoQ2').rows) {
          if (String(row.cells[0]).startsWith('Total in Figures')) {
            row.cells[52] = (row.cells[52] as number) + 1000;
          }
        }
        return sheets;
      },
    } as unknown as BoqWorkbookReader;

    const report = await service(tampered).validate({
      buffer: file('NEWAI_SHAHID_SMARAK.xls'),
      ...CALLER,
    });

    expect(report.confirmable).toBe(false);
    expect(report.batchId).toBeNull();
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]).toMatchObject({
      code: BOQ_ERRORS.notReconciled,
      sheet: 'BoQ2',
    });
    expect(report.blockers[0].message).toContain('₹1,000.00');
  });
});
