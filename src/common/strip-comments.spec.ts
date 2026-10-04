import { stripComments } from './strip-comments';

/**
 * Both cases that actually happened, as tests — then the limits, stated rather than discovered.
 */
describe('stripComments', () => {
  it('removes a commented-out call, so a comment cannot satisfy a requirement', () => {
    // `e2e-teardown.spec.ts`'s original defect: it checked for `app.close()` anywhere in the
    // file and passed when the call was commented out.
    const source = ['beforeAll(() => {});', '// await app.close();'].join('\n');
    expect(stripComments(source)).not.toContain('app.close()');
  });

  it('removes a docblock quoting a forbidden form, so a comment cannot violate a ban', () => {
    // `swc-interop.spec.ts`'s defect: its own docblock quotes `import * as … from 'pdfkit'` to
    // explain why that form is wrong, and the guard flagged itself the moment it was committed.
    const source = [
      '/**',
      " * So `import * as PDFDocument from 'pdfkit'` is wrong under SWC.",
      ' */',
      "import PDFDocument = require('pdfkit');",
    ].join('\n');

    const stripped = stripComments(source);
    expect(stripped).not.toMatch(/import \* as \w+ from 'pdfkit'/);
    expect(stripped).toContain("import PDFDocument = require('pdfkit');");
  });

  it('leaves a URL alone, which is the whole reason for the colon guard', () => {
    // `https://x` ends in `//x`. Without the `[^:]` the stripper would eat the rest of any line
    // containing a URL — and docblocks here are full of them.
    expect(stripComments("const u = 'https://example.com/a';")).toContain(
      'https://example.com/a',
    );
  });

  it('cannot tell a comment from the same characters inside a string', () => {
    // Stated, not hidden. Over-stripping makes a guard miss something and say so when the real
    // case appears; the alternative it replaces is a guard that passes for the wrong reason.
    expect(stripComments("const s = 'a // b';")).toBe("const s = 'a ");
  });
});
