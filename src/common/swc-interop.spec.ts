import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

import { stripComments } from './strip-comments';

/**
 * A CommonJS module that *is* a function is imported with `import = require`, never
 * `import * as`.
 *
 * ## The defect this exists for
 *
 * On 2026-10-04 every PDF the server produces failed in production with
 * `TypeError: _pdfkit is not a constructor`, and every PDF test passed.
 *
 * The two halves of the project are built by two different compilers:
 *
 * - **the application** by SWC (`nest-cli.json` sets `"builder": "swc"`), which gives
 *   `import * as X from 'cjs'` its true ESM meaning — `X` is a *namespace object* built by
 *   `_interop_require_wildcard`, and a namespace object cannot be called or constructed;
 * - **the tests** by ts-jest, which compiles with `esModuleInterop` off (see
 *   `tsconfig.json`) and emits a bare `const X = require('cjs')` — so `X` is the function
 *   itself and `new X()` works.
 *
 * So `import * as PDFDocument from 'pdfkit'` is correct under the compiler that proves it
 * and wrong under the compiler that ships it. The unit test at
 * `src/projects/pnl/position-export.service.spec.ts` rendered a PDF and asserted on its
 * bytes, green the whole time, while "Export this month — PDF" returned *That export could
 * not be produced* for every report in the application.
 *
 * `import PDFDocument = require('pdfkit')` emits a bare require under **both** compilers,
 * which is why it is the form required here. It is also the form `@types/pdfkit` is written
 * for: the package declares `export =`.
 *
 * Only modules that are themselves callable are affected. `exceljs`, `xlsx`, `fs` and the
 * rest are read through their properties (`ExcelJS.Workbook`, `XLSX.read`), and a namespace
 * object carries properties perfectly well — which is exactly why this went unnoticed: the
 * same import spelling is right in eight files and wrong in four.
 *
 * Deliberately a source scan. No test run under ts-jest can reproduce an SWC emit, so the
 * only thing a runtime check could prove here is the thing that was never in doubt.
 *
 * **This guard's first version failed against itself, and only after it was committed.** The
 * docblock above quotes the forbidden form in order to explain it, and `git ls-files` does not
 * list an untracked file — so it was green while it was being written and red one commit later,
 * naming itself. Comments are stripped below for that reason, which is exactly what
 * `e2e-teardown.spec.ts` already did and what this should have done from the start: a comment is
 * not an import, in either direction.
 */

/** Modules whose CommonJS export is the callable itself, so the namespace form breaks. */
const CALLABLE_MODULES = ['pdfkit'];

/** Source files tracked by git, so a stray file in `dist/` or a scratch copy is not read. */
function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', 'src', 'test'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts'));
}

describe('callable CommonJS modules survive the SWC build', () => {
  const files = trackedSources();

  /** Read once, comments removed. Prose discussing an import is not an import. */
  const sourceOf = new Map(
    files.map((f) => [f, stripComments(readFileSync(f, 'utf8'))] as const),
  );

  for (const moduleName of CALLABLE_MODULES) {
    describe(moduleName, () => {
      const importers = files.filter((f) =>
        new RegExp(`(from|require\\()\\s*'${moduleName}'`).test(
          sourceOf.get(f) ?? '',
        ),
      );

      it('is imported by the files this guard is here to protect', () => {
        // Vacuity. The assertion below is `toEqual([])`, which passes just as happily over
        // a list of no importers at all — so if the import is ever renamed or the detection
        // regex drifts, this is the test that says so rather than a silent green.
        expect(importers.length).toBeGreaterThan(0);
      });

      it('is never imported as a namespace', () => {
        const offenders = importers.filter((f) =>
          new RegExp(`import \\* as \\w+ from '${moduleName}'`).test(
            sourceOf.get(f) ?? '',
          ),
        );

        // Named, not counted: the fix is one line in each file named. Four names appeared
        // here on 2026-10-04 — the salary slip, the HR letter, the recruitment letter and
        // the dashboard report exporter.
        expect(offenders).toEqual([]);
      });

      it('still exports a bare callable, which is what makes the namespace form wrong', () => {
        // The premise, pinned. If a future version of the package ships `__esModule` and a
        // `.default`, SWC's interop would start handing back something constructible and
        // this whole guard would be obsolete rather than merely unnecessary. Better to be
        // told that by a failing test than to leave a rule in place whose reason expired.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const loaded = require(moduleName);
        expect(typeof loaded).toBe('function');
        expect(loaded.__esModule).toBeUndefined();
        expect(loaded.default).toBeUndefined();
      });
    });
  }
});
