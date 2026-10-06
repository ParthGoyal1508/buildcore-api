import { inflateSync } from 'zlib';

/**
 * The text a rendered PDF actually shows, for tests that must read a document rather than trust it.
 *
 * ## Why this exists
 *
 * `test/bill-package.e2e-spec.ts` asserted that the bill PDF began `%PDF-` and exceeded a thousand
 * bytes. Both are true of a PDF carrying none of the right figures, and 028 FR-004 is precisely a
 * defect where the figures were wrong on the document while every column behind it was correct. A
 * test that cannot read the document cannot catch that.
 *
 * ## No new dependency
 *
 * `pdfkit` writes; reading normally means adding a parser. This needs neither: `pdfkit` compresses
 * its content streams with Flate, and Node's own `zlib` inflates them. What comes out is a content
 * stream whose shown text sits in `( … )` literals ahead of the `Tj` / `TJ` operators, which is
 * enough to answer "does this document say 1,250.00".
 *
 * ## Two string forms, and the one that caught me out
 *
 * A PDF can show text as a `( … )` literal or as a `< … >` hex string, and **pdfkit writes hex**:
 *
 *     BT /F1 12 Tf [<5265636f> 15 <76> 25 <6572> -30 <7920312c3333372e3432>] TJ ET
 *
 * The first version of this read only literals and returned the empty string for every document in
 * the repository, which the test then reported as a missing figure. Both forms are decoded here.
 *
 * Only streams that look like content streams are read — an embedded font subset inflates to binary
 * that is full of accidental hex runs, and including it would turn any assertion about digits into a
 * coin toss.
 *
 * It is deliberately not a PDF parser. It does not resolve fonts, encodings, or positioning, and it
 * makes no attempt at reading order — a figure split across a `TJ` array comes back without its
 * separators. Compare with `pdfDigits` below rather than against a formatted string.
 */
export function pdfText(pdf: Buffer): string {
  const chunks: string[] = [];
  let cursor = 0;

  for (;;) {
    const start = pdf.indexOf('stream', cursor);
    if (start === -1) break;
    const end = pdf.indexOf('endstream', start);
    if (end === -1) break;

    let from = start + 'stream'.length;
    // A stream keyword is followed by CRLF or LF, and the bytes begin after it.
    if (pdf[from] === 0x0d) from += 1;
    if (pdf[from] === 0x0a) from += 1;

    const raw = pdf.subarray(from, end);
    let decoded: string;
    try {
      decoded = inflateSync(raw).toString('latin1');
    } catch {
      // Not every stream is compressed — an uncompressed page is ordinary.
      decoded = raw.toString('latin1');
    }
    // Content streams only. A font subset inflates to binary whose accidental hex runs would
    // otherwise be read as text.
    if (/\bT[Jj]\b/.test(decoded)) chunks.push(decoded);
    cursor = end + 'endstream'.length;
  }

  const content = chunks.join('\n');
  const shown: string[] = [];
  // Both string forms a show operator accepts: a `( … )` literal, escapes allowed inside, and a
  // `< … >` hex string, which is what pdfkit writes.
  const token = /\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(content)) !== null) {
    if (match[1] !== undefined) {
      const hex = match[1].replace(/\s+/g, '');
      if (hex.length % 2 !== 0) continue;
      shown.push(Buffer.from(hex, 'hex').toString('latin1'));
      continue;
    }
    shown.push(match[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
  }
  return shown.join(' ');
}

/**
 * The same text reduced to its digits, for comparing a figure without depending on how it was
 * spaced, grouped or split.
 *
 * `1,250.00` may reach the content stream as one literal or as several, and with or without its
 * separators, depending on kerning. The digits are what the assertion is about.
 */
export function pdfDigits(pdf: Buffer): string {
  return pdfText(pdf).replace(/[^0-9]/g, '');
}
