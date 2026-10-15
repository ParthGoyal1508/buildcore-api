import { LetterFieldSource } from '@prisma/client';
import { join } from 'path';

import { FORBIDDEN_FIELD_PATH_FRAGMENTS } from '../settings/letter-kinds/letter-kind-fields.service';
import { parseBlocks } from './letter-pdf.renderer';
import {
  STANDARD_LETTER_TEMPLATES,
  SUPPLIED_TOKENS,
  tokensIn,
} from './standard-letter-templates';
import { LINE_ITEM_INPUTS } from './line-items';

// eslint-disable-next-line @typescript-eslint/no-var-requires -- fontkit ships no types.
const fontkit = require('fontkit');
const LETTER_FACE = fontkit.openSync(
  join(__dirname, 'fonts', 'Inter-Regular.woff'),
);

/**
 * The shipped letter bodies (2026-10-11; transfer, termination and F&F added 2026-10-13).
 *
 * ## The failure these defend against
 *
 * **A token with no declared field renders blank.** `renderTemplate` substitutes an
 * unresolved token with an empty string — deliberately, because a letter that goes out
 * reading `{{employeeName}}` is worse than one with a gap. The consequence is that a
 * mistyped token is invisible: the compose screen never asks for it, the letter renders
 * without complaint, and what reaches the recipient is a sentence with a hole in it. On a
 * relieving letter the hole is the dates somebody's next employer is checking.
 *
 * So the test is not "does it render" — it always renders. It is that the body and the
 * field declarations agree in both directions, for every one shipped.
 */
describe('standard letter templates', () => {
  const byKey = new Map(STANDARD_LETTER_TEMPLATES.map((t) => [t.kindKey, t]));

  it('ships the nine the client asked for, and the three project letters', () => {
    expect([...byKey.keys()].sort()).toEqual([
      'appointment',
      'experience',
      'fnf_settlement',
      'increment',
      'letter_loi',
      'letter_purchase_order',
      'letter_work_order',
      'offer',
      'payment_advice',
      'relieving',
      'termination',
      'transfer',
    ]);
  });

  describe.each(STANDARD_LETTER_TEMPLATES)('$kindKey', (template) => {
    const declared = new Set(template.fields.map((f) => f.token));
    // The item table's inputs are read by the expansion, not the body (`line-items.ts`), so a
    // body printing the table uses them through it.
    const used = [
      ...tokensIn(template.body),
      ...(tokensIn(template.body).includes('lineItemsTable')
        ? LINE_ITEM_INPUTS.filter((t) => declared.has(t))
        : []),
    ];

    it('declares every token the body uses', () => {
      // The direction that matters: an undeclared token is never asked for and renders
      // as a blank in a signed document.
      // Less the ones the render supplies — the date, the reference, the table and its totals.
      expect(
        used.filter((t) => !declared.has(t) && !SUPPLIED_TOKENS.has(t)),
      ).toEqual([]);
    });

    it('uses every token it declares', () => {
      // The other direction. A declared token the body does not use is a question put to
      // whoever is issuing the letter whose answer goes nowhere — and it trains people to
      // type into boxes that do not matter.
      expect(
        [...declared].filter((t) => !(used as string[]).includes(t)),
      ).toEqual([]);
    });

    it('gives every non-manual field a source path', () => {
      // The database enforces this with a CHECK; getting it wrong here means the install
      // fails at runtime on a constraint rather than here.
      for (const field of template.fields) {
        if (field.sourceType === LetterFieldSource.manual) {
          expect(field.sourcePath).toBeNull();
        } else {
          expect(field.sourcePath).toBeTruthy();
        }
      }
    });

    it('declares each token once', () => {
      expect(declared.size).toBe(template.fields.length);
    });

    it('reads no path a letter is forbidden to read', () => {
      // `assertPathPermitted` refuses these at install and at render. A shipped template
      // tripping it would fail to install for every company — and `pan` is a substring
      // check, so an innocent-looking path can trip it.
      for (const field of template.fields) {
        const path = (field.sourcePath ?? '').toLowerCase();
        for (const fragment of FORBIDDEN_FIELD_PATH_FRAGMENTS) {
          expect(path).not.toContain(fragment.toLowerCase());
        }
      }
    });

    it('reads the record keys the letters registry publishes', () => {
      // The registry's records are flat (`designation`, `basicAnnual`), not the Prisma
      // shapes the first templates guessed at (`designation.name`, `basic.annual`). A
      // path into a shape that does not exist resolves to nothing, so the field never
      // pre-fills and nobody notices until HR types it every time.
      for (const field of template.fields) {
        expect(field.sourcePath ?? '').not.toMatch(/\.name$|\.annual$/);
      }
    });

    it('uses only characters the PDF font can print', () => {
      // Measured against the face the renderer embeds (2026-10-15), not a list of what it is
      // believed to hold: built-in Helvetica printed "₹" as "¹" and "☐" as "&". Inter has the
      // rupee sign; it still has no "☐", which is why the boxes are "[ ]".
      const outside = [...new Set(template.body)].filter(
        (c) =>
          c !== '\n' && !LETTER_FACE.hasGlyphForCodePoint(c.codePointAt(0)!),
      );
      expect(outside).toEqual([]);
    });
  });

  describe('the tables the renderer has to lay out', () => {
    it('reads two tables out of the appointment letter’s annexure', () => {
      // Earnings and employer contributions, as the client's Annexure I has them. A body
      // whose pipe rows did not parse would render them as literal text with pipes, which
      // is how a salary annexure becomes unreadable.
      const appointment = byKey.get('appointment')!;
      const tables = parseBlocks(appointment.body).filter(
        (b) => b.kind === 'table',
      );
      expect(tables).toHaveLength(2);
    });

    it('lays the payment advice out as a detail block and a particulars table', () => {
      const advice = byKey.get('payment_advice')!;
      const tables = parseBlocks(advice.body).filter((b) => b.kind === 'table');
      expect(tables).toHaveLength(2);
      // The particulars table carries the six columns the client's document has, and a
      // TOTAL row beneath. Asserting only "there is a table" would pass for a one-column
      // list.
      const particulars = tables[1];
      if (particulars.kind !== 'table') throw new Error('expected a table');
      expect(particulars.rows[0]).toHaveLength(6);
    });
  });

  describe('the F&F settlement sheet', () => {
    const fnf = byKey.get('fnf_settlement')!;
    const tables = parseBlocks(fnf.body).filter((b) => b.kind === 'table');

    it('lays out every table section of the client’s form', () => {
      // Header, A, B, C, D, E, F and G. H is a checklist of prose lines.
      expect(tables).toHaveLength(8);
      for (const section of 'ABCDEFGH') {
        // A heading line (`## A. …`) since 2026-10-15, bold as the form prints them.
        expect(fnf.body).toMatch(new RegExp(`(^|\\n)(## )?${section}\\. `));
      }
    });

    it('heads only the tables that have column headings', () => {
      // B, C and E have them; the label / value grids do not, and a bold first row on
      // those reads as a heading that is not one.
      expect(tables.map((t) => (t.kind === 'table' ? t.headed : null))).toEqual(
        [false, false, true, true, false, true, false, false],
      );
    });

    it('keeps the lawful-deduction and acknowledgement wording verbatim', () => {
      expect(fnf.body).toContain(
        'C. DEDUCTIONS / RECOVERIES (ONLY WHERE LAWFUL AND VERIFIED)',
      );
      expect(fnf.body).toContain(
        'It does not by itself authorise withholding statutory wages or making ' +
          'an unverified deduction.',
      );
      expect(fnf.body).toContain(
        'My signature confirms receipt/review of this statement and does not waive ' +
          'any statutory right or prevent me from raising a genuine discrepancy or ' +
          'claim permitted by law.',
      );
    });

    it('asks for nothing HR cannot leave blank', () => {
      // A sheet that is filled in progressively: a field the records do not hold must
      // never block issuing it.
      const required = fnf.fields
        .filter((f) => f.isRequired)
        .map((f) => f.token)
        .sort();
      expect(required).toEqual(['designation', 'employeeCode', 'employeeName']);
      for (const field of fnf.fields.filter(
        (f) => f.sourceType === LetterFieldSource.manual,
      )) {
        expect(field.isRequired).toBe(false);
      }
    });
  });

  describe('the salary annexure is the client’s Annexure I', () => {
    it('prints their rows, and Site Allowance only for somebody paid one', () => {
      // Changed deliberately on 2026-10-15. The annexure used to show only the heads the system
      // holds; the client then asked for their formats to be followed strictly, and their
      // Annexure I has Dearness and Medical Allowance and a Meal Voucher row. The record states
      // those as nil (the structure pays none of them). Site Allowance, which the system pays and
      // their document lacks, is an optional row so the figures still add up for those who get it.
      const appointment = byKey.get('appointment')!;
      for (const row of [
        'Basic Salary',
        'House Rent Allowance (HRA)',
        'Dearness Allowance',
        'Conveyance Allowance',
        'Medical Allowance',
        'Special Allowance',
        'Gross Salary',
        'PF Employer',
        'ESI Employer',
        'Meal Voucher',
        'Total CTC (A+B)',
        'Net Take-Home',
      ]) {
        expect(appointment.body).toContain(`| ${row} |`);
      }
      expect(appointment.body).toContain('{{?siteAllowanceMonthly}}');
    });

    it('numbers the clauses straight through its three sections', () => {
      // One list in the client's document — Probation, Notice Period and General Policies
      // continue each other's numbering, 1 to 33.
      const numbers = byKey
        .get('appointment')!
        .body.split('\n')
        .map((line) => /^(\d+)\. /.exec(line)?.[1])
        .filter(Boolean)
        .map(Number);
      expect(numbers).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
    });
  });

  describe('the transfer letter', () => {
    it('names the destination project, not the one its source document was copied from', () => {
      // "Transfer letter.docx" transfers somebody to one project and then says their
      // skills will contribute to "the Jaipur Ring Road project".
      const transfer = byKey.get('transfer')!.body;
      expect(transfer).not.toContain('Jaipur');
      expect(transfer.match(/\{\{toProject\}\}/g)).toHaveLength(2);
    });
  });

  describe('the increment letter', () => {
    it('works out the article before the designation instead of fixing "an"', () => {
      // "as an Project Manager" went out in production: the format's "as an Electrician".
      const increment = byKey.get('increment')!.body;
      expect(increment).not.toMatch(/\b(a|an) \{\{designation\}\}/);
      expect(increment).toContain('as {{designationArticle}} {{designation}}');
    });
  });

  describe('the HR formats’ amounts', () => {
    it('print with the rupee sign, as the client’s formats do', () => {
      for (const key of ['appointment', 'increment', 'fnf_settlement']) {
        expect(byKey.get(key)!.body).toContain('₹');
        expect(byKey.get(key)!.body).not.toMatch(/Rs\./);
      }
    });
  });

  describe('wording that must not carry a guess', () => {
    it('takes pronouns as fields, and hardcodes none', () => {
      // The client's relieving draft says "he" throughout because it was written for one
      // man. Baking that in misgenders the next person it is issued for. Which *forms* a
      // body needs is the body's business, so the assertion is that the experience
      // letter's pronouns are tokens and that no gendered word survives in any body.
      expect(
        tokensIn(byKey.get('experience')!.body).some((t) =>
          t.startsWith('pronoun'),
        ),
      ).toBe(true);
      for (const template of STANDARD_LETTER_TEMPLATES) {
        expect(template.body).not.toMatch(/\b(he|him|his|she|her|hers)\b/i);
        // "Mr." is the salutation token's to supply, not the body's.
        expect(template.body).not.toMatch(/\b(Mr|Ms|Mrs)\./);
      }
    });

    it('never starts a sentence with a pronoun token', () => {
      // A token cannot be capitalised by substitution, so `{{pronounSubject}}` after a
      // full stop renders "he is amiable in nature" — which the first draft of the
      // relieving letter did, and which only showed up on the rendered page.
      for (const template of STANDARD_LETTER_TEMPLATES) {
        expect(template.body).not.toMatch(/[.!?]\s+\{\{\s*pronoun/);
        expect(template.body).not.toMatch(/(^|\n)\s*\{\{\s*pronoun/);
      }
    });

    it('carries no real person’s name, salary or address from the source documents', () => {
      // The six Word files were written for named individuals. Every one of them is a
      // token now; this is the test that says so.
      const everything = STANDARD_LETTER_TEMPLATES.map((t) => t.body).join(
        '\n',
      );
      for (const leaked of [
        'Mohit',
        'Chaudhary',
        'Ramen Manna',
        'Gopal Kumar',
        'Imran',
        'Laxman Singh',
        '9649598438',
        '1724084',
        'TIRUPATI ENTERPRISES, DEOLI',
        'Milan Manna',
        'Arvind',
        '8302400695',
        'Shushant',
        'Shankar',
        'Inder Khatri',
        'DV-09',
      ]) {
        expect(everything).not.toContain(leaked);
      }
    });
  });
});
