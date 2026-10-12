import {
  financialYear,
  formatReference,
  nextReference,
  referencePrefix,
  serialOf,
} from './letter-reference';

/**
 * Letter reference numbers (2026-10-11).
 *
 * The vacuity to avoid here is asserting that `nextReference` returns *a* string, or that
 * two calls differ. Both hold for a counter that never resets, which is the whole thing
 * the client asked for: the series restarts each April, and a letter issued on 1 April
 * must be `0001` even though the company issued four hundred the year before.
 */
describe('letter reference numbers', () => {
  describe('the financial year', () => {
    it('turns on 1 April, not 1 January', () => {
      // 31 March belongs to the year that is ending; 1 April starts the next.
      expect(financialYear(new Date(2027, 2, 31))).toBe('2026-27');
      expect(financialYear(new Date(2027, 3, 1))).toBe('2027-28');
    });

    it('writes the second year as two digits, as the client’s documents do', () => {
      expect(financialYear(new Date(2026, 8, 16))).toBe('2026-27');
      // The turn of the century is the case a naive `+ 1` gets wrong: 2099-100.
      expect(financialYear(new Date(2099, 8, 16))).toBe('2099-00');
    });
  });

  describe('the prefix', () => {
    it('files a letter to a person under HR', () => {
      expect(referencePrefix('PRPL', true, new Date(2026, 8, 16))).toBe(
        'PRPL/HR/2026-27/',
      );
    });

    it('leaves HR out of a letter that is not addressed to a person', () => {
      // A work order to a subcontractor. Filing an award under HR is the kind of thing
      // noticed once, by an auditor.
      expect(referencePrefix('PRPL', false, new Date(2026, 8, 16))).toBe(
        'PRPL/2026-27/',
      );
    });
  });

  describe('allocation', () => {
    const prefix = 'PRPL/HR/2026-27/';

    it('starts at 0001 when nothing has been issued', () => {
      expect(nextReference(prefix, [])).toBe('PRPL/HR/2026-27/0001');
    });

    it('continues from the highest already issued, not from the count', () => {
      // Counting rows gives 0003 here and collides with the existing 0003. The gap is
      // real — a composed letter that was rejected never took its number.
      expect(
        nextReference(prefix, ['PRPL/HR/2026-27/0001', 'PRPL/HR/2026-27/0003']),
      ).toBe('PRPL/HR/2026-27/0004');
    });

    it('restarts at 0001 in the new financial year', () => {
      // The point of the whole design. Last year's four hundred letters share a company
      // but not a prefix, so they are invisible to this year's series — which is what
      // makes the reset happen with no counter to roll over and no job to run.
      const lastYear = Array.from({ length: 400 }, (_, i) =>
        formatReference('PRPL/HR/2025-26/', i + 1),
      );
      expect(nextReference('PRPL/HR/2026-27/', lastYear)).toBe(
        'PRPL/HR/2026-27/0001',
      );
    });

    it('ignores a reference that is not of this series', () => {
      // Another company's, or a hand-typed one from before the column existed.
      expect(
        nextReference(prefix, ['TE/2026-27/HR/0099', 'PRPL/HR/2026-27/0002']),
      ).toBe('PRPL/HR/2026-27/0003');
    });
  });

  describe('reading a reference back', () => {
    it('returns null for a reference belonging to another prefix', () => {
      // Null, not 0: 0 is a serial this would otherwise have to claim it had seen, and
      // the allocator would then treat a foreign reference as a real one at zero.
      expect(serialOf('TE/2026-27/HR/0005', 'PRPL/HR/2026-27/')).toBeNull();
      expect(serialOf('PRPL/HR/2026-27/0005', 'PRPL/HR/2026-27/')).toBe(5);
    });

    it('returns null when the tail is not a number', () => {
      expect(serialOf('PRPL/HR/2026-27/DRAFT', 'PRPL/HR/2026-27/')).toBeNull();
    });
  });
});
