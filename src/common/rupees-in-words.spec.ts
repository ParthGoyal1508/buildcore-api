import { rupeesFirstInWords, rupeesInWords } from './rupees-in-words';

describe('rupeesFirstInWords', () => {
  it('leads with the currency, as the HR letters do', () => {
    expect(rupeesFirstInWords(40000)).toBe('Rupees Forty Thousand Only');
  });

  it('uses lakh and crore, not hundred thousand', () => {
    expect(rupeesFirstInWords(120000)).toBe(
      'Rupees One Lakh Twenty Thousand Only',
    );
    expect(rupeesFirstInWords(12500000)).toBe(
      'Rupees One Crore Twenty Five Lakh Only',
    );
  });

  it('keeps paise, so the words agree with the figure beside them', () => {
    expect(rupeesFirstInWords(12345.5)).toBe(
      'Rupees Twelve Thousand Three Hundred Forty Five and Fifty Paise Only',
    );
  });

  it('leaves the payslip wording alone', () => {
    expect(rupeesInWords(40000)).toBe('Forty Thousand Rupees Only');
  });
});
