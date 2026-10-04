import { readFileSync } from 'fs';
import { join } from 'path';

import {
  describeStoredFile,
  detectContentType,
  extensionFor,
} from './file-type';

/**
 * Where it can, this suite sniffs **real files from this repository** rather than hand-written
 * signature bytes. A test that asserts `%PDF-` is detected as a PDF against a buffer containing
 * only `%PDF-` proves the constant matches itself; running it over a PDF that pdfkit actually
 * produced proves it matches a PDF.
 */
const PDF_FIXTURE = (() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  doc.text('a document');
  doc.end();
  return new Promise<Buffer>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );
})();

describe('detectContentType', () => {
  it('recognises a PDF that pdfkit actually produced', async () => {
    expect(detectContentType(await PDF_FIXTURE)).toEqual({
      contentType: 'application/pdf',
      extension: '.pdf',
    });
  });

  it('recognises the legacy .xls container the client sends tenders in', () => {
    // The real tender workbook, when it is present. It is 3.6MB of client data and is not
    // required to be distributable, so this skips with a reason rather than failing — but it
    // never passes silently, which is the rule the BOQ suites already follow.
    const path = join(process.cwd(), 'docs', 'BOQ_794578.xls');
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      console.warn(
        'SKIPPED: docs/BOQ_794578.xls is absent, so the OLE2 signature was not checked ' +
          'against a real workbook.',
      );
      return;
    }
    expect(detectContentType(bytes)).toEqual({
      contentType: 'application/vnd.ms-excel',
      extension: '.xls',
    });
  });

  it('tells an .xlsx from a bare zip by its members, not by its signature', () => {
    // Both begin `PK\x03\x04`. The difference is what is inside, which is why the detector
    // looks past the signature — a workbook served as application/zip downloads as an archive.
    const xlsx = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('\0\0\0\0xl/workbook.xml'),
    ]);
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('\0\0\0\0photos/site.jpg'),
    ]);

    expect(detectContentType(xlsx)?.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(detectContentType(zip)?.contentType).toBe('application/zip');
  });

  it('recognises the image formats a phone camera produces', () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(8),
    ]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(8),
    ]);
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBP'),
    ]);

    expect(detectContentType(jpeg)?.extension).toBe('.jpg');
    expect(detectContentType(png)?.extension).toBe('.png');
    expect(detectContentType(webp)?.extension).toBe('.webp');
  });

  it('returns null for anything it does not recognise, rather than guessing', () => {
    // The whole value of the fallback is that it is honest. A detector that returned a
    // plausible type for arbitrary bytes would make the browser render the wrong thing with
    // confidence, which is worse than the octet-stream it replaces.
    expect(
      detectContentType(Buffer.from('just some text, at length')),
    ).toBeNull();
    expect(detectContentType(Buffer.from([1, 2, 3]))).toBeNull();
  });
});

describe('extensionFor', () => {
  it('ignores parameters on the content type', () => {
    expect(extensionFor('application/pdf; charset=binary')).toBe('.pdf');
    expect(extensionFor('APPLICATION/PDF')).toBe('.pdf');
  });

  it('has no answer for a type it does not know', () => {
    expect(extensionFor('application/octet-stream')).toBeNull();
    expect(extensionFor(null)).toBeNull();
  });
});

describe('describeStoredFile', () => {
  const pdfBytes = Buffer.from('%PDF-1.3\nrest of the file');

  it('keeps the uploader’s own file name when one was recorded', async () => {
    expect(
      describeStoredFile({
        bytes: await PDF_FIXTURE,
        storedName: 'Tender — Whitefield Phase II.pdf',
        storedType: 'application/pdf',
        fallbackName: 'Bill-of-quantities-abc123',
      }),
    ).toEqual({
      filename: 'Tender — Whitefield Phase II.pdf',
      contentType: 'application/pdf',
    });
  });

  it('gives a document filed before the columns existed a type and an extension', () => {
    // The defect, exactly: four documents on the client's own project, every one of them
    // `Bill-of-quantities-<id>` with no extension and octet-stream, opening as text.
    expect(
      describeStoredFile({
        bytes: pdfBytes,
        storedName: null,
        storedType: null,
        fallbackName: 'Bill-of-quantities-cmu40n3',
      }),
    ).toEqual({
      filename: 'Bill-of-quantities-cmu40n3.pdf',
      contentType: 'application/pdf',
    });
  });

  it('prefers the bytes over a stored octet-stream, which is not a claim about the file', () => {
    // That is what a browser sends for a type it does not recognise. Treating it as the
    // uploader's assertion would preserve the bug for every document uploaded from a browser
    // that did not know the format.
    expect(
      describeStoredFile({
        bytes: pdfBytes,
        storedName: null,
        storedType: 'application/octet-stream',
        fallbackName: 'Insurance-abc',
      }),
    ).toEqual({
      filename: 'Insurance-abc.pdf',
      contentType: 'application/pdf',
    });
  });

  it('believes a stored type over the bytes when the two disagree', () => {
    // Deliberate. The uploader's browser knows formats this detector does not, and the
    // sniffer's silence must not overrule a real answer.
    const result = describeStoredFile({
      bytes: Buffer.from('plain text with no signature at all'),
      storedName: null,
      storedType: 'text/csv',
      fallbackName: 'Rates-abc',
    });
    expect(result).toEqual({
      filename: 'Rates-abc.csv',
      contentType: 'text/csv',
    });
  });

  it('adds an extension to a stored name that has none', () => {
    expect(
      describeStoredFile({
        bytes: pdfBytes,
        storedName: 'scan0001',
        storedType: null,
        fallbackName: 'unused',
      }).filename,
    ).toBe('scan0001.pdf');
  });

  it('falls back to octet-stream with no extension when nothing is known', () => {
    expect(
      describeStoredFile({
        bytes: Buffer.from('unrecognised bytes here'),
        storedName: null,
        storedType: null,
        fallbackName: 'Work-order-abc',
      }),
    ).toEqual({
      filename: 'Work-order-abc',
      contentType: 'application/octet-stream',
    });
  });
});
