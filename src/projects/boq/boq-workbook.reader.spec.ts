import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { BadRequestException } from '@nestjs/common';
import { Workbook } from 'exceljs';

import { BOQ_WORKBOOK_ERRORS, BoqWorkbookReader } from './boq-workbook.reader';

const REAL_FILE = join(process.cwd(), 'docs', 'BOQ_794578.xls');

/** A minimal real `.xlsx`, built rather than committed — two rows is not worth a fixture file. */
async function xlsxBuffer(rows: (string | number | null)[][]): Promise<Buffer> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * Asserts the call is refused **with** the given code.
 *
 * `rejects`, never `.catch(cb)`: a `.catch` whose callback never runs passes silently, which is
 * precisely the failure shape this whole feature exists to make impossible. Caught here in the
 * first draft of this file, which is the argument for writing it down.
 */
async function expectRefusal(
  call: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(call).rejects.toBeInstanceOf(BadRequestException);
  await call.then(
    () => {
      throw new Error(
        `expected a refusal with code ${code}, but the call resolved`,
      );
    },
    (error: unknown) => {
      const response = (error as BadRequestException).getResponse() as {
        code?: string;
      };
      expect(response.code).toBe(code);
    },
  );
}

describe('BoqWorkbookReader', () => {
  const reader = new BoqWorkbookReader();

  it('reads an .xlsx into plain rows, 1-based and dense', async () => {
    const sheets = await reader.read(
      await xlsxBuffer([
        ['Item Description', 'Quantity', 'Units'],
        ['Earth work', 12.5, 'Cum'],
      ]),
    );

    expect(sheets).toHaveLength(1);
    expect(sheets[0].rows[0]).toEqual({
      rowNumber: 1,
      cells: ['Item Description', 'Quantity', 'Units'],
    });
    expect(sheets[0].rows[1].cells).toEqual(['Earth work', 12.5, 'Cum']);
  });

  it('refuses a file that is not a workbook at all, naming that condition', async () => {
    await expectRefusal(
      reader.read(Buffer.from('id,name\n1,a\n')),
      BOQ_WORKBOOK_ERRORS.unreadable,
    );
    await expectRefusal(
      reader.read(Buffer.from('not a workbook')),
      BOQ_WORKBOOK_ERRORS.unreadable,
    );
  });

  it('refuses a text file renamed .xls rather than reading it as empty', async () => {
    // The filename is irrelevant here by design — routing is on the magic bytes, because a
    // renamed file is the common case and the extension is the one thing that can lie.
    await expectRefusal(
      reader.read(Buffer.from('<html>tender portal error page</html>')),
      BOQ_WORKBOOK_ERRORS.unreadable,
    );
  });

  it('refuses a workbook whose sheets are all empty, instead of returning no rows', async () => {
    // FR-036, and the whole reason this class exists: an empty *result* is indistinguishable from
    // a working import of an empty project, so the empty *condition* has to be a refusal.
    await expectRefusal(
      reader.read(await xlsxBuffer([])),
      BOQ_WORKBOOK_ERRORS.empty,
    );
  });

  it('refuses an oversized buffer before trying to parse it', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024);
    // Deliberately not a valid workbook: if the size check did not come first this would fail as
    // unreadable, so the assertion proves the ordering and not just the limit.
    await expectRefusal(
      reader.read(oversized),
      BOQ_WORKBOOK_ERRORS.fileTooLarge,
    );
  });

  describe('the client’s real .xls', () => {
    const present = (() => {
      try {
        return statSync(REAL_FILE).isFile();
      } catch {
        return false;
      }
    })();

    // T094: skipped reports as skipped, with the reason, and never as passed.
    (present ? it : it.skip)(
      'reads where exceljs returns zero sheets — the measurement this amendment rests on',
      async () => {
        const buffer = readFileSync(REAL_FILE);

        const viaExcelJs = new Workbook();
        await viaExcelJs.xlsx.load(buffer as never);
        // Not an error. Zero sheets, silently — research §15.
        expect(viaExcelJs.worksheets).toHaveLength(0);

        const sheets = await reader.read(buffer);
        expect(sheets.length).toBeGreaterThan(0);
        expect(sheets[0].rows.length).toBeGreaterThan(100);
      },
    );
  });

  it('is the only file in src/ that imports SheetJS', () => {
    // Constitution v1.5.0's boundary clause, asserted because it decays silently: a second import
    // would work perfectly and nobody would notice until the library had to be replaced.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (path.endsWith(join('boq', 'boq-workbook.reader.ts'))) continue;
        if (path.endsWith(join('boq', 'boq-workbook.reader.spec.ts'))) continue;
        if (
          /from '(xlsx|xlsx\/.*)'|require\('xlsx'\)/.test(
            readFileSync(path, 'utf8'),
          )
        ) {
          offenders.push(path);
        }
      }
    };
    walk(join(process.cwd(), 'src'));

    expect(offenders).toEqual([]);
  });
});
