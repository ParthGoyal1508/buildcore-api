import { csvCell, csvRow } from './csv';

describe('csvCell (036 B14)', () => {
  it.each([
    ['=HYPERLINK("http://x","y")', `"'=HYPERLINK(""http://x"",""y"")"`],
    ['+cmd|calc', `"'+cmd|calc"`],
    ['-2+3', `"'-2+3"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    ['\tTAB', `"'\tTAB"`],
  ])('neutralises %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it('leaves ordinary text and negative amounts alone', () => {
    expect(csvCell('Rajesh "RK" Kulkarni')).toBe('"Rajesh ""RK"" Kulkarni"');
    expect(csvCell('-1500')).toBe('"-1500"');
    expect(csvCell('-12.5')).toBe('"-12.5"');
    expect(csvCell(null)).toBe('""');
  });

  it('joins a row', () => {
    expect(csvRow(['a', '=b', 3])).toBe(`"a","'=b","3"`);
  });
});
