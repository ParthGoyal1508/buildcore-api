import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

import type { BillWorkbookView } from './bill-workbook.types';
import {
  FIXED_SHEET_NAMES,
  assertSheetName,
  measurementSheetName,
} from './sheet-names';
import { writeAbstractSheet } from './sheets/abstract.sheet';
import { writeCheckListSheet } from './sheets/check-list.sheet';
import { writeDebitNoteSheet } from './sheets/debit-note.sheet';
import { writeMeasurementSheet } from './sheets/measurement.sheet';
import { writeScheduleSheet } from './sheets/schedule.sheet';

/**
 * The bill package as a spreadsheet (023 US3, FR-024 to FR-030a).
 *
 * ## `import * as ExcelJS` is correct here
 *
 * This repository builds the application with **SWC** and runs the tests with **ts-jest with
 * `esModuleInterop` off**, and the two disagree about what `import * as X` means. `exceljs` is read
 * through its properties — `new ExcelJS.Workbook()` — and a namespace object carries properties
 * perfectly well under either compiler. Only a module whose export *is* the callable breaks, which
 * is what `src/common/swc-interop.spec.ts` guards and why `pdfkit` is imported differently. Eight
 * files already use this form against `exceljs`.
 *
 * ## It holds no database client, and that is the design
 *
 * The constructor takes nothing. The only input is a `BillWorkbookView` whose every figure is
 * already a rounded string. So FR-028 — "every figure comes from the stored bill and none is
 * recomputed at production time, and a bill produced twice is identical" — is a property of what
 * this class **can see**, not a rule somebody has to keep remembering. A renderer that could query
 * could recompute, and the first time it did, a reproduced bill would stop matching the copy in the
 * client's file.
 *
 * `T078` asserts the absence directly, because an absence nothing checks is an absence somebody
 * adds a constructor parameter to.
 *
 * ## Why this stands beside the existing renderer rather than extending it
 *
 * `src/dashboard/reports/export/export-renderer.ts` turns `{columns, rows}` into **one flat sheet**.
 * This is five structurally different sheets, one of them repeated per schedule line, with a
 * four-block abstract and merged cells. There is no shared abstraction to extract that would not be
 * an empty wrapper (research §6).
 */
@Injectable()
export class BillWorkbookRenderer {
  /**
   * The workbook, as bytes.
   *
   * **Sheet order is the client's own** (FR-024, SC-002): check list, abstract, priced schedule, the
   * measurement sheets, the debit register. A reviewer finds each figure by where it sits, and a
   * workbook carrying all five in a different order is one they have to search.
   */
  async render(view: BillWorkbookView): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = view.header.issuer.name ?? 'BuildCore';

    // Pinned rather than left to the clock. Two productions of one bill must differ in nothing a
    // reader can see, and a workbook records when it was written — so the timestamp is the bill's
    // own date, which does not move. FR-028 is about every *cell* being identical, and this keeps
    // the file's metadata from being the one thing that is not.
    const stamp = new Date(`${view.header.billDate}T00:00:00.000Z`);
    workbook.created = stamp;
    workbook.modified = stamp;

    const used = new Set<string>();

    writeCheckListSheet(
      workbook.addWorksheet(assertSheetName(FIXED_SHEET_NAMES.checkList, used)),
      view,
    );
    writeAbstractSheet(
      workbook.addWorksheet(assertSheetName(FIXED_SHEET_NAMES.abstract, used)),
      view,
    );
    writeScheduleSheet(
      workbook.addWorksheet(assertSheetName(FIXED_SHEET_NAMES.schedule, used)),
      view,
    );

    // One sheet per schedule line, **including lines with nothing claimed this period** (FR-030).
    // Named by position, which is the only naming that cannot collide or overflow 31 characters on
    // a 312-item schedule — the item is printed inside each sheet instead.
    view.measurementSheets.forEach((item, index) => {
      writeMeasurementSheet(
        workbook.addWorksheet(
          assertSheetName(measurementSheetName(index + 1), used),
        ),
        item,
        view,
      );
    });

    writeDebitNoteSheet(
      workbook.addWorksheet(
        assertSheetName(FIXED_SHEET_NAMES.debitRegister, used),
      ),
      view,
    );

    const bytes = await workbook.xlsx.writeBuffer();
    return Buffer.from(bytes);
  }

  /**
   * The sheet names a view would produce, without producing it.
   *
   * Exported so the count assertion (FR-030a, T074) can be made against a **number computed from
   * the input** rather than a number typed into a test. An assertion over the sheets a workbook
   * contains passes just as happily over a short list, and a missing sheet is a smaller invoice.
   */
  sheetNamesFor(view: BillWorkbookView): string[] {
    return [
      FIXED_SHEET_NAMES.checkList,
      FIXED_SHEET_NAMES.abstract,
      FIXED_SHEET_NAMES.schedule,
      ...view.measurementSheets.map((_, index) =>
        measurementSheetName(index + 1),
      ),
      FIXED_SHEET_NAMES.debitRegister,
    ];
  }
}
