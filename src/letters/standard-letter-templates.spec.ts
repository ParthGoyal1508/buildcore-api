import { LetterFieldSource } from '@prisma/client';

import { parseBlocks } from './letter-pdf.renderer';
import {
  STANDARD_LETTER_TEMPLATES,
  tokensIn,
} from './standard-letter-templates';

/**
 * The shipped letter bodies (2026-10-11).
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
 * field declarations agree in both directions, for all six.
 */
describe('standard letter templates', () => {
  const byKey = new Map(STANDARD_LETTER_TEMPLATES.map((t) => [t.kindKey, t]));

  it('ships the six the client asked for', () => {
    expect([...byKey.keys()].sort()).toEqual([
      'appointment',
      'experience',
      'increment',
      'offer',
      'payment_advice',
      'relieving',
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

  describe('wording that must not carry a guess', () => {
    it('takes pronouns as fields, and hardcodes none', () => {
      // The client's relieving draft says "he" throughout because it was written for one
      // man. Baking that in misgenders the next person it is issued for. Which *forms* a
      // body needs is the body's business — the relieving letter needs object and
      // possessive, the experience certificate subject and possessive — so the assertion
      // is that pronouns are tokens and that no gendered word survives as text.
      for (const key of ['relieving', 'experience']) {
        const body = byKey.get(key)!.body;
        expect(tokensIn(body).some((t) => t.startsWith('pronoun'))).toBe(true);
        expect(body).not.toMatch(/\b(he|him|his|she|her|hers)\b/i);
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
      ]) {
        expect(everything).not.toContain(leaked);
      }
    });
  });
});
