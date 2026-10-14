import { LetterFieldSource } from '@prisma/client';

import { FORBIDDEN_FIELD_PATH_FRAGMENTS } from '../settings/letter-kinds/letter-kind-fields.service';
import { parseBlocks } from './letter-pdf.renderer';
import {
  STANDARD_LETTER_TEMPLATES,
  tokensIn,
} from './standard-letter-templates';

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
    const used = tokensIn(template.body);

    it('declares every token the body uses', () => {
      // The direction that matters: an undeclared token is never asked for and renders
      // as a blank in a signed document.
      expect(used.filter((t) => !declared.has(t))).toEqual([]);
    });

    it('uses every token it declares', () => {
      // The other direction. A declared token the body does not use is a question put to
      // whoever is issuing the letter whose answer goes nowhere — and it trains people to
      // type into boxes that do not matter.
      expect([...declared].filter((t) => !used.includes(t))).toEqual([]);
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
      // The renderer sets the body in Helvetica, a built-in font with the WinAnsi
      // character set. "₹", "☐" and "−" are outside it and print as "¹", "&" and a stray
      // quote — measured, not supposed. Curly quotes and dashes are inside it.
      const outside = [...template.body].filter(
        (c) => !/[\n\x20-\x7E\u00A0-\u00FF‘’“”–—…•]/.test(c),
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
        expect(fnf.body).toMatch(new RegExp(`(^|\\n)${section}\\. `));
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

  describe('the salary annexure uses the heads this system actually holds', () => {
    it('reads Site Allowance and does not promise a Dearness or Medical Allowance', () => {
      // Confirmed with the client on 2026-10-11. Their Word document shows DA and Medical
      // rows; the employee record holds neither, so a letter promising them would name a
      // figure no payslip ever shows.
      const appointment = byKey.get('appointment')!;
      const used = tokensIn(appointment.body);
      expect(used).toContain('siteAllowanceMonthly');
      expect(used.filter((t) => /dearness|medical/i.test(t))).toEqual([]);
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
