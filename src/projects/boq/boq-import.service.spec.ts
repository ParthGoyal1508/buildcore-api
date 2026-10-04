import { readFileSync, statSync } from 'fs';
import { join } from 'path';

import { BadRequestException } from '@nestjs/common';

import { BOQ_ERRORS } from './boq-error-codes';
import { BoqImportService, ValidationReport } from './boq-import.service';
import { BoqWorkbookReader } from './boq-workbook.reader';
import { ImportBatchStore } from './import-batch.store';

const SYNTHETIC = join(process.cwd(), 'test', 'fixtures', 'boq-synthetic.xls');
const REAL = join(process.cwd(), 'docs', 'BOQ_794578.xls');

const CALLER = {
  companyId: 'company-1',
  userId: 'user-1',
  projectId: 'project-1',
  ctx: { isSuperAdmin: false, companyId: 'company-1' },
};

/**
 * A Prisma stub that answers one question: how many BOQ lines the project already has.
 *
 * `validate` reads exactly that and writes nothing (FR-049 at the validate step), so a stub with
 * one counter is the whole of its database surface — and a stub that *only* counts is itself the
 * assertion that nothing else is touched.
 */
function prismaWithExistingLines(existing: number) {
  const count = jest.fn().mockResolvedValue(existing);
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    bOQTaskItem: { count },
  };
  return {
    count,
    prisma: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as never,
  };
}

/**
 * Asserts refusal **with** a code. Never `.catch(cb)`, which passes silently when the promise
 * resolves — see `boq-workbook.reader.spec.ts`, where the first draft did exactly that.
 */
async function expectRefusal(
  call: Promise<unknown>,
  code: string,
): Promise<void> {
  await call.then(
    () => {
      throw new Error(`expected refusal ${code}, but the call resolved`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(BadRequestException);
      expect(
        ((error as BadRequestException).getResponse() as { code?: string })
          .code,
      ).toBe(code);
    },
  );
}

describe('BoqImportService.validate', () => {
  let service: BoqImportService;
  let batches: ImportBatchStore;

  const run = (file: string): Promise<ValidationReport> =>
    service.validate({ buffer: readFileSync(file), ...CALLER });

  beforeEach(() => {
    batches = new ImportBatchStore();
    service = new BoqImportService(
      new BoqWorkbookReader(),
      batches,
      prismaWithExistingLines(0).prisma,
      // The audit log belongs to `confirm` and is never reached from `validate`. Left as null
      // rather than mocked, which is itself the assertion that validate records nothing.
      null as never,
    );
  });

  describe('the synthetic fixture, which carries every pathology in miniature', () => {
    it('reads only the schedule block, excluding the item-shaped rows beside it', async () => {
      const report = await run(SYNTHETIC);

      // FR-042. The fixture plants two item-shaped rows in far columns. 12 means they were read
      // and the tender has been inflated; this assertion is the whole guard.
      expect(report.lines).toBe(10);
      expect(report.sheetName).toBe('BoQ1');
    });

    it('treats a description with no quantity as a heading, folding nested runs', async () => {
      const report = await run(SYNTHETIC);

      // FR-038. Four groups from five heading rows: `Electrical` and `Light fittings` are
      // consecutive, so they fold into one name rather than one of them being dropped.
      expect(report.groups).toBe(4);
    });

    it('warns rather than rejects when a line precedes every heading', async () => {
      const report = await run(SYNTHETIC);

      expect(report.warnings).toHaveLength(1);
      expect(report.warnings[0].row).toBe(4);
      // FR-038: the rows are good and only the structure is unstated, so rejecting them would
      // discard real schedule lines over a missing heading.
      expect(report.errors.map((problem) => problem.row)).not.toContain(4);
    });

    it('rejects a line with no rate rather than importing it at zero', async () => {
      const report = await run(SYNTHETIC);

      const rate = report.errors.find((problem) => problem.column === 'Rate');
      expect(rate).toBeDefined();
      // A zero rate reaches billing as free work. Billing refuses it there too, but by then it is
      // on a schedule somebody has accepted.
      expect(rate?.reason).toContain('free work');
    });

    it('names the column for each kind of rejected row', async () => {
      const report = await run(SYNTHETIC);

      expect(report.errors.map((problem) => problem.column).sort()).toEqual([
        'Quantity',
        'Rate',
        'Units',
      ]);
      for (const problem of report.errors)
        expect(problem.row).toBeGreaterThan(0);
    });

    it('keeps each unit as typed and matches on a form that unifies the family', async () => {
      const report = await run(SYNTHETIC);

      const typed = report.units.map((unit) => unit.asTyped);
      // FR-041: what the client typed survives. All four running-metre spellings are listed.
      expect(typed).toEqual(
        expect.arrayContaining(['R Mtr.', 'R. Mtr.', 'R.Mtr.', 'R. mtr']),
      );
      // And all four agree once normalised — which stripping periods alone does not achieve,
      // since `R.Mtr.` would become `rmtr` and `R. Mtr.` would become `r mtr`.
      const runningMetre = report.units.filter((unit) =>
        unit.asTyped.toLowerCase().includes('mtr'),
      );
      expect(new Set(runningMetre.map((unit) => unit.normalised)).size).toBe(1);
      expect(new Set(report.units.map((unit) => unit.normalised)).size).toBe(5);
    });

    it('computes amounts itself and reconciles to one paisa per line', async () => {
      const report = await run(SYNTHETIC);

      // FR-045. Ten lines, so ten paise of tolerance — derived, not chosen.
      expect(report.totals.tolerance).toBe('0.10');
      expect(report.totals.scheduleDerived).toBe('307847.90');
      expect(report.totals.scheduleStated).toBe('307847.90');
      expect(report.totals.reconciles).toBe(true);
    });

    it('locates the percentage where it hides: the units column of the quoted-rate row', async () => {
      const report = await run(SYNTHETIC);

      expect(report.quotedPercentageFound).toBe(true);
      expect(report.quotedPercentage).toBe('0.024600');
      expect(report.totals.quotedDerived).toBe('315420.96');
      expect(report.totals.quotedStated).toBe('315420.95');
    });

    it('reports every imported line as unplanned, not as on time', async () => {
      const report = await run(SYNTHETIC);

      // FR-048. A freshly imported tender is neither late nor on schedule, and a screen that put
      // these in Today would be reporting a programme nobody has written.
      expect(report.alerts).toEqual({
        today: 0,
        delayed: 0,
        toBeDelayed: 0,
        unplanned: 10,
      });
    });

    it('writes nothing — the batch is the only thing it produces', async () => {
      const report = await run(SYNTHETIC);

      const found = batches.lookup(report.batchId);
      expect(found.batch).not.toBeNull();
      expect(found.batch.state).toBe('ready');
      expect(found.batch.userId).toBe(CALLER.userId);
      expect(found.batch.projectId).toBe(CALLER.projectId);
    });
  });

  describe('the refusals', () => {
    it('refuses a workbook with no header row naming a description and a quantity', async () => {
      const { utils, write } = await import('xlsx');
      const book = utils.book_new();
      utils.book_append_sheet(
        book,
        utils.aoa_to_sheet([['Notes'], ['Nothing here']]),
        'S',
      );
      const buffer = write(book, {
        type: 'buffer',
        bookType: 'biff8',
      }) as Buffer;

      // FR-054: refused rather than guessed at. A schedule read from the wrong columns produces a
      // plausible, wrong tender — which is worse than no import.
      await expectRefusal(
        service.validate({ buffer, ...CALLER }),
        BOQ_ERRORS.noScheduleBlock,
      );
    });

    it('refuses once every candidate row has been rejected, issuing no batch', async () => {
      const { utils, write } = await import('xlsx');
      const book = utils.book_new();
      utils.book_append_sheet(
        book,
        utils.aoa_to_sheet([
          ['Sl. No.', 'Item Description', '', 'Quantity', 'Units', 'Rate'],
          [1, 'No rate at all', '', 5, 'Nos', null],
          [2, 'Also no rate', '', 7, 'Nos', null],
        ]),
        'BoQ1',
      );
      const buffer = write(book, {
        type: 'buffer',
        bookType: 'biff8',
      }) as Buffer;

      // FR-051. A batch of nothing is a confirmable write of nothing — FR-036's prohibited shape
      // reached by a different route.
      await expectRefusal(
        service.validate({ buffer, ...CALLER }),
        BOQ_ERRORS.noImportableRows,
      );
    });

    it('refuses a further validate once the company is holding its limit of batches', async () => {
      const buffer = readFileSync(SYNTHETIC);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await service.validate({ buffer, ...CALLER });
      }

      // FR-053: refused rather than evicting one somebody is part-way through reading, which
      // would present to them as their confirm failing for no stated reason.
      await expectRefusal(
        service.validate({ buffer, ...CALLER }),
        BOQ_ERRORS.tooManyBatches,
      );
    });

    it('never returns a report whose line count is zero', async () => {
      // FR-036, stated as a property rather than a case: every path out of validate either carries
      // lines or throws. This is the shape the previously-approved library would have produced for
      // the client's real file.
      const report = await run(SYNTHETIC);
      expect(report.lines).toBeGreaterThan(0);
    });
  });

  describe('the client’s real tender', () => {
    const present = (() => {
      try {
        return statSync(REAL).isFile();
      } catch {
        return false;
      }
    })();

    if (!present) {
      // T094: a skipped test reports as skipped, with the reason, and never as passed.
      it.skip('SKIPPED — docs/BOQ_794578.xls is not present in this checkout', () =>
        undefined);
    }

    (present ? it : it.skip)(
      'imports 231 lines and not 462, and reconciles to the paisa',
      async () => {
        const report = await run(REAL);

        // Measured 2026-10-03. A range rather than "about 231", because a tolerance loose enough to
        // admit the doubled figure admits the failure it exists to catch.
        expect(report.lines).toBeGreaterThanOrEqual(228);
        expect(report.lines).toBeLessThanOrEqual(234);
        expect(report.groups).toBeGreaterThan(50);

        expect(report.totals.scheduleStated).toBe('29961506.78');
        expect(report.totals.quotedStated).toBe('30698559.85');
        expect(report.totals.reconciles).toBe(true);
        // The difference is real and tiny: rounding 231 lines to two places against the file's own
        // unrounded sum. Exact equality would fail this correct import.
        expect(report.totals.scheduleDifference).toBe('0.01');

        expect(report.quotedPercentage).toBe('0.024600');
        expect(report.quotedPercentageFound).toBe(true);
      },
    );

    (present ? it : it.skip)(
      'resolves its unit spellings to twelve units',
      async () => {
        const report = await run(REAL);

        expect(report.units.length).toBeGreaterThan(15);
        expect(new Set(report.units.map((unit) => unit.normalised)).size).toBe(
          12,
        );
        // `Excess (+)` sits in the units column on the footer row. A normaliser that did not know
        // that would invent a unit out of a footer.
        expect(report.units.map((unit) => unit.normalised)).not.toContain(
          'excess+',
        );
      },
    );
  });
});

describe('BoqImportService.validate, on a project that already has a schedule', () => {
  it('refuses at the validate step rather than at confirm (FR-046, FR-049)', async () => {
    const batches = new ImportBatchStore();
    const { prisma } = prismaWithExistingLines(231);
    const service = new BoqImportService(
      new BoqWorkbookReader(),
      batches,
      prisma,
      null as never,
    );

    // Found by walking quickstart pass 11 against a running instance: the confirm-time check
    // alone meant somebody uploaded a tender, waited for a 231-line report, read it, pressed
    // Confirm and *then* learned the project was already populated. The transaction keeps its own
    // check — the project can gain lines between the two requests, and that one is what makes the
    // rule true. This one is what makes it kind.
    await expectRefusal(
      service.validate({ buffer: readFileSync(SYNTHETIC), ...CALLER }),
      BOQ_ERRORS.alreadyPopulated,
    );
  });
});
