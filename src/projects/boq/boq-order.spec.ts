import { compareBoqNo, sortByBoqNo } from './boq-order';

const order = (numbers: string[]) =>
  sortByBoqNo(numbers.map((boqNo) => ({ boqNo }))).map((row) => row.boqNo);

describe('BOQ order', () => {
  /** The reported defect, on the client's own 231-line schedule. */
  it('puts 2 before 10, which text order does not', () => {
    expect(order(['1', '10', '100', '101', '11', '2', '3'])).toEqual([
      '1',
      '2',
      '3',
      '10',
      '11',
      '100',
      '101',
    ]);
  });

  /**
   * The case that rules out parsing `boqNo` as a float, which is the obvious fix and is wrong:
   * `4.10 === 4.1` as a number, so the tenth sub-item would collide with the first and sort
   * before the second.
   */
  it('orders a dotted sub-item by each segment, so 4.10 follows 4.9', () => {
    expect(order(['4.10', '4.2', '4.1', '4.9'])).toEqual([
      '4.1',
      '4.2',
      '4.9',
      '4.10',
    ]);
  });

  /** `parseFloat('12A')` is 12, which would put two different lines in one place. */
  it('keeps a suffixed line distinct from the plain one, and in sequence', () => {
    expect(order(['13', '12A', '12', '12B'])).toEqual([
      '12',
      '12A',
      '12B',
      '13',
    ]);
  });

  it('does not reorder lines that are already in sequence', () => {
    const already = ['1', '2', '3', '4'];
    expect(order(already)).toEqual(already);
  });

  it('handles a schedule whose numbers are not numbers at all', () => {
    expect(order(['Preliminaries', 'A-2', 'A-10', 'A-1'])).toEqual([
      'A-1',
      'A-2',
      'A-10',
      'Preliminaries',
    ]);
  });

  it('reports equality for the same number, so a sort stays stable on ties', () => {
    expect(compareBoqNo('7', '7')).toBe(0);
  });

  /**
   * Sorting the real schedule's shape: 231 lines whose text order is badly wrong. Asserts the
   * boundaries rather than the whole list — a 231-element literal would pass by being regenerated
   * from the implementation rather than from the rule.
   */
  it('orders a full 231-line schedule numerically end to end', () => {
    const numbers = Array.from({ length: 231 }, (_, i) => String(i + 1));
    const shuffled = [...numbers].sort(); // Text order: 1, 10, 100, 101, …
    expect(shuffled[1]).toBe('10');

    const sorted = order(shuffled);
    expect(sorted[0]).toBe('1');
    expect(sorted[1]).toBe('2');
    expect(sorted[9]).toBe('10');
    expect(sorted[230]).toBe('231');
  });
});
