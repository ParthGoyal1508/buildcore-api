import { equipmentCode, equipmentPrefixFor, serialOf } from './equipment-code';

/**
 * A machine's code: `JCB01/2027`, `TM01/2024` (2026-10-11).
 *
 * The two examples the business gave are the two shapes real names come in — a short
 * make leading the name, and a description that has to be initialised — so both are
 * asserted as whole strings rather than by pattern. A `toMatch(/JCB/)` would pass for
 * `JCB01/2024` with the wrong year in it, which is the half of the code the yard reads
 * to tell two identical backhoes apart.
 */
describe('equipment codes', () => {
  describe('the prefix', () => {
    it('keeps a short make that already leads the name', () => {
      // "JCB" is what everyone calls it; initialising to "JBL" would throw that away.
      expect(equipmentPrefixFor('JCB 3DX Backhoe Loader')).toBe('JCB');
      expect(equipmentPrefixFor('JCB')).toBe('JCB');
    });

    it('initialises a descriptive name', () => {
      expect(equipmentPrefixFor('Transit Mixer')).toBe('TM');
      expect(equipmentPrefixFor('Tower Crane')).toBe('TC');
    });

    it('caps initials at three', () => {
      expect(equipmentPrefixFor('Self Loading Concrete Mixer')).toBe('SLC');
    });

    it('falls back to two letters when a single long word initialises to one', () => {
      // "T" is no use as a prefix — every tipper, trailer and tractor would share it.
      expect(equipmentPrefixFor('Tipper')).toBe('TI');
    });

    it('ignores digits and punctuation when splitting words', () => {
      // L / T / EXCAVATOR — the ampersand is a word break, so this initialises to
      // LTE rather than keeping the maker's "LT". Not ideal and not wrong; a yard that
      // wants LT supplies the code, which has always been honoured.
      expect(equipmentPrefixFor('L&T 9020 Excavator')).toBe('LTE');
      expect(equipmentPrefixFor('  jcb  3dx  ')).toBe('JCB');
    });

    it('never returns an empty prefix', () => {
      // A name of pure digits would otherwise produce `01/2027`, which reads as a date.
      expect(equipmentPrefixFor('2024')).toBe('EQ');
    });
  });

  describe('the whole code', () => {
    it('renders the two examples the business gave', () => {
      expect(equipmentCode('JCB', 1, 2027)).toBe('JCB01/2027');
      expect(equipmentCode('TM', 1, 2024)).toBe('TM01/2024');
    });

    it('pads the serial to two and lets it outgrow that rather than wrapping', () => {
      expect(equipmentCode('JCB', 9, 2027)).toBe('JCB09/2027');
      expect(equipmentCode('JCB', 10, 2027)).toBe('JCB10/2027');
      // The hundredth JCB is JCB100, not JCB00 reissued.
      expect(equipmentCode('JCB', 100, 2027)).toBe('JCB100/2027');
    });
  });

  describe('reading a serial back', () => {
    it('reads its own codes', () => {
      expect(serialOf('JCB07/2027', 'JCB')).toBe(7);
    });

    it('refuses a longer prefix’s code', () => {
      // Without this, TM01/2024 would move T's series and the next "Tipper" would be
      // TI02 with no TI01 anywhere.
      expect(serialOf('TM01/2024', 'T')).toBeNull();
    });

    it('refuses a plate number the yard typed', () => {
      // A supplied code must not move a series it was never part of.
      expect(serialOf('TMX-44', 'TM')).toBeNull();
      expect(serialOf('TM01', 'TM')).toBeNull();
      expect(serialOf('TM01/24', 'TM')).toBeNull();
    });
  });
});
