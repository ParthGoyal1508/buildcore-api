const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

/** Under 100, spelled out. */
function twoDigitsInWords(value: number): string {
  if (value < 20) {
    return ONES[value];
  }
  const tens = TENS[Math.floor(value / 10)];
  const ones = ONES[value % 10];
  return ones ? `${tens} ${ones}` : tens;
}

/**
 * A non-negative integer in words, on the Indian numbering system.
 *
 * The crore group recurses rather than calling `twoDigitsInWords` directly: a
 * figure of a hundred crore or more has a three-digit crore count, and spelling it
 * with a two-digit speller would silently produce `undefined` in the middle of a
 * payslip.
 */
function integerInWords(value: number): string {
  if (value === 0) {
    return 'Zero';
  }

  const groups: Array<[number, string]> = [
    [10_000_000, 'Crore'],
    [100_000, 'Lakh'],
    [1_000, 'Thousand'],
    [100, 'Hundred'],
  ];

  let remainder = value;
  const parts: string[] = [];
  for (const [divisor, label] of groups) {
    const count = Math.floor(remainder / divisor);
    if (count > 0) {
      parts.push(
        `${
          count >= 100 ? integerInWords(count) : twoDigitsInWords(count)
        } ${label}`,
      );
      remainder %= divisor;
    }
  }
  if (remainder > 0) {
    parts.push(twoDigitsInWords(remainder));
  }
  return parts.join(' ');
}

/**
 * A rupee amount in words, on the Indian numbering system (lakh/crore).
 *
 * Not a generic English number speller: an Indian payslip is expected to read
 * "One Lakh Twenty Thousand", and rendering "One Hundred Twenty Thousand" on a
 * statutory wage document would look wrong to every person who receives one.
 */
export function rupeesInWords(amount: number): string {
  if (!Number.isFinite(amount)) {
    return '';
  }
  const negative = amount < 0;
  const absolute = Math.abs(amount);
  const rupees = Math.floor(absolute);
  const paise = Math.round((absolute - rupees) * 100);

  const rupeeWords = `${negative ? 'Minus ' : ''}${integerInWords(
    rupees,
  )} Rupees`;
  return paise > 0
    ? `${rupeeWords} and ${twoDigitsInWords(paise)} Paise Only`
    : `${rupeeWords} Only`;
}
