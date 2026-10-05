/**
 * FR-041. The client's own tender file holds `88.02000000000001` in 33 of its 231 item-number
 * cells — a fill series whose cached results carry accumulated float error. Excel renders fifteen
 * significant digits and hides it; `String()` did not, and the noise reached a BOQ.
 */
import { itemNumberForTest as itemNumber } from './boq-import.service';

describe('a schedule item number', () => {
  it('renders a drifted fill-series value the way the spreadsheet shows it', () => {
    expect(itemNumber(88.02000000000001, 1)).toBe('88.02');
    expect(itemNumber(91.05000000000003, 1)).toBe('91.05');
    expect(itemNumber(88.03000000000002, 1)).toBe('88.03');
  });

  it('leaves a clean number alone', () => {
    expect(itemNumber(1, 1)).toBe('1');
    expect(itemNumber(30.1, 1)).toBe('30.1');
    expect(itemNumber(3.19, 1)).toBe('3.19');
  });

  it('passes text through verbatim', () => {
    // Real item numbers that are not numbers. Reformatting these would invent a number the file
    // does not contain.
    expect(itemNumber('3.19.1', 1)).toBe('3.19.1');
    expect(itemNumber('88(a)', 1)).toBe('88(a)');
  });

  it('falls back to the row number for an empty cell', () => {
    expect(itemNumber(null, 42)).toBe('42');
    expect(itemNumber(undefined, 42)).toBe('42');
  });
});
