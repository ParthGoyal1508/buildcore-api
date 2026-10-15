import {
  composeAddress,
  formatIndianAmount,
  genderOfSalutation,
  indefiniteArticle,
  MONEY_TOKENS,
  presentLetterValues,
  tickBoxes,
} from './letter-values';
import { standardTemplateFor } from './standard-letter-templates';

/**
 * How a letter's values are printed (2026-10-15) — each case one of the faults the production
 * letters showed: "Rs. 20000", "35833", "an Project Manager", "Site site", and the registered
 * office printed with its city, state and PIN twice.
 */
describe('letter values as printed', () => {
  describe('formatIndianAmount', () => {
    it.each([
      ['20000', '20,000'],
      ['600000', '6,00,000'],
      ['35833', '35,833'],
      ['12345678.50', '1,23,45,678.50'],
      ['999', '999'],
      ['0', '0'],
      ['0.00', '0.00'],
      ['-2500', '-2,500'],
    ])('groups %s as %s', (typed, printed) => {
      expect(formatIndianAmount(typed)).toBe(printed);
    });

    it('regroups an amount typed with commas in the wrong places, or with a currency', () => {
      expect(formatIndianAmount('600,000')).toBe('6,00,000');
      expect(formatIndianAmount('6,00,000')).toBe('6,00,000');
      expect(formatIndianAmount('₹ 55000')).toBe('55,000');
      expect(formatIndianAmount('Rs.55,000/-')).toBe('55,000');
    });

    it('leaves words alone', () => {
      for (const typed of ['N/A', '', '[Basic — monthly]', 'as per actuals']) {
        expect(formatIndianAmount(typed)).toBe(typed);
      }
    });
  });

  describe('indefiniteArticle', () => {
    it.each([
      ['Project Manager', 'a'],
      ['Electrician', 'an'],
      ['Engineer', 'an'],
      ['Accountant', 'an'],
      ['Site Engineer', 'a'],
      ['Unit Head', 'a'],
      ['HR Executive', 'an'],
      ['MIS Executive', 'an'],
      ['QA/QC Engineer', 'a'],
      ['Office Assistant', 'an'],
    ])('says "%s" takes "%s"', (designation, article) => {
      expect(indefiniteArticle(designation)).toBe(article);
    });
  });

  describe('composeAddress', () => {
    it('does not repeat the city, state and PIN an address already names', () => {
      // Production's F&F header: "…Deoli, Tonk, Rajasthan - 304804, Deoli, Rajasthan - 304804".
      expect(
        composeAddress({
          address:
            '28A, Gandhi Nagar, Ward No. 15, Teli Mohalla, Deoli, Tonk, Rajasthan - 304804',
          city: 'Deoli',
          state: 'Rajasthan',
          pinCode: '304804',
        }),
      ).toBe(
        '28A, Gandhi Nagar, Ward No. 15, Teli Mohalla, Deoli, Tonk, Rajasthan - 304804',
      );
    });

    it('adds the parts an address leaves out', () => {
      expect(
        composeAddress({
          address: '28A, Gandhi Nagar',
          city: 'Deoli',
          state: 'Rajasthan',
          pinCode: '304804',
        }),
      ).toBe('28A, Gandhi Nagar, Deoli, Rajasthan - 304804');
      expect(composeAddress({ city: 'Deoli', pinCode: '304804' })).toBe(
        'Deoli - 304804',
      );
      expect(composeAddress({})).toBe('');
    });
  });

  describe('tickBoxes', () => {
    const options = [
      { label: 'Bank Transfer', matches: /neft|bank/i },
      { label: 'Cheque', matches: /cheque/i },
    ];
    it('ticks the option named, keeping the detail', () => {
      expect(tickBoxes('NEFT', options)).toBe(
        '[X] Bank Transfer (NEFT)  [ ] Cheque',
      );
      expect(tickBoxes('cheque', options)).toBe(
        '[ ] Bank Transfer  [X] Cheque',
      );
    });
    it('leaves every box open when blank', () => {
      expect(tickBoxes('', options)).toBe('[ ] Bank Transfer  [ ] Cheque');
    });
  });

  describe('presentLetterValues', () => {
    it('groups every declared money token, and only those', () => {
      const out = presentLetterValues('fnf_settlement', {
        totalPayable: '35833',
        uan: '100987654321',
        bankLast4: '4821',
      });
      expect(out.totalPayable).toBe('35,833');
      expect(out.uan).toBe('100987654321');
      expect(out.bankLast4).toBe('4821');
    });

    it('declares as money only tokens its kind’s template uses', () => {
      for (const [kind, tokens] of Object.entries(MONEY_TOKENS)) {
        const declared = new Set(
          standardTemplateFor(kind)!.fields.map((f) => f.token),
        );
        for (const token of tokens) expect(declared).toContain(token);
      }
    });

    it('gives the increment letter its article', () => {
      expect(
        presentLetterValues('increment', { designation: 'Project Manager' })
          .designationArticle,
      ).toBe('a');
      expect(
        presentLetterValues('increment', { designation: 'Electrician' })
          .designationArticle,
      ).toBe('an');
    });

    it('does not print "Site site" on a transfer', () => {
      expect(
        presentLetterValues('transfer', { reportingSite: 'Dabla Chanda Site' })
          .reportingSite,
      ).toBe('Dabla Chanda');
      expect(
        presentLetterValues('transfer', { reportingSite: 'Dabla Chanda' })
          .reportingSite,
      ).toBe('Dabla Chanda');
    });

    it('prints the offer’s grade only when there is one', () => {
      for (const typed of ['S3', 'S3 Grade', '(S3 Grade)']) {
        expect(presentLetterValues('offer', { grade: typed }).grade).toBe(
          ' (S3 Grade)',
        );
      }
      expect(presentLetterValues('offer', { grade: '' }).grade).toBe('');
    });

    it('ticks the F&F payment mode and status, or leaves the boxes open', () => {
      const out = presentLetterValues('fnf_settlement', {
        paymentMode: 'RTGS',
        paymentStatus: 'Part paid',
      });
      expect(out.paymentMode).toBe(
        '[X] Bank Transfer (RTGS)  [ ] Cheque  [ ] Cash',
      );
      expect(out.paymentStatus).toBe('[ ] Paid  [X] Part-paid  [ ] Pending');
      const blank = presentLetterValues('fnf_settlement', {});
      expect(blank.paymentMode).toBe('[ ] Bank Transfer  [ ] Cheque  [ ] Cash');
      expect(blank.paymentStatus).toBe('[ ] Paid  [ ] Part-paid  [ ] Pending');
      expect(
        presentLetterValues('fnf_settlement', { paymentStatus: 'Paid' })
          .paymentStatus,
      ).toBe('[X] Paid  [ ] Part-paid  [ ] Pending');
    });

    it('lets a salutation decide the relation and pronouns the record left neutral', () => {
      const out = presentLetterValues('experience', {
        salutation: 'Mr.',
        relation: 'S/o / D/o',
        pronounObject: 'them',
        pronounPossessive: 'their',
      });
      expect(out).toMatchObject({
        relation: 'S/o',
        pronounObject: 'him',
        pronounPossessive: 'his',
      });
      expect(
        presentLetterValues('experience', {
          salutation: 'Ms.',
          relation: 'S/o / D/o',
          pronounObject: 'them',
        }),
      ).toMatchObject({ relation: 'D/o', pronounObject: 'her' });
    });

    it('never replaces a relation HR typed, nor guesses without a salutation', () => {
      expect(
        presentLetterValues('experience', {
          salutation: 'Ms.',
          relation: 'W/o',
        }).relation,
      ).toBe('W/o');
      expect(
        presentLetterValues('experience', {
          salutation: '',
          relation: 'S/o / D/o',
        }).relation,
      ).toBe('S/o / D/o');
      expect(genderOfSalutation('Dr.')).toBeNull();
    });
  });
});
