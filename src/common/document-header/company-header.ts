/**
 * The company band every generated PDF opens with (055, 2026-11-02).
 *
 * The client: every PDF not printed on the letterhead — the purchase order first among them —
 * shows the registered and corporate office, the email and the website, with a bigger logo and a
 * bigger name. Until then each renderer drew its own band with whatever subset of the address it
 * had been handed, so the same company read differently on a PO, a payment advice and a payslip.
 * The lines are built here once; renderers with a page of their own draw them with
 * {@link drawCompanyHeader}, and the ruled formats (bill, debit note, form documents) set the
 * same lines inside their own boxes.
 */

/** pdfkit's document, as far as this file uses it. */
type Doc = PDFKit.PDFDocument;

export interface CompanyContact {
  /** The head office's address, on one line. */
  registeredOffice: string | null;
  /** `Company.corporateAddress`, where it differs from the registered office. */
  corporateOffice?: string | null;
  /** The issuing branch's address, when the document belongs to a branch other than the head office. */
  branchOffice?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
}

export interface CompanyHeader {
  name: string;
  logo: Buffer | null;
  /** {@link companyContactLines}, ready to print. */
  lines: string[];
}

/**
 * A website as a link someone can type: lower case, with its scheme. Settings holds what was
 * typed — "WWW.PARTHREALCON.COM" — and the client wants "https://parthrealcon.com" style links.
 */
export function websiteUrl(raw: string | null | undefined): string | null {
  const site = raw?.trim().toLowerCase().replace(/\/+$/, '');
  if (!site) return null;
  return /^https?:\/\//.test(site) ? site : `https://${site}`;
}

/** An address part written the same way, for comparing two offices. */
const sameAddress = (a: string, b: string) =>
  a.replace(/[^a-z0-9]/gi, '').toLowerCase() ===
  b.replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * The lines under the company's name: each office on its own line, labelled, then phone, email
 * and website. A blank part is left out; an office identical to the registered office is
 * printed once.
 */
export function companyContactLines(contact: CompanyContact): string[] {
  const regd = contact.registeredOffice?.trim() || null;
  const office = (label: string, value: string | null | undefined) => {
    const text = value?.trim();
    if (!text || (regd && sameAddress(text, regd))) return null;
    return `${label}: ${text}`;
  };
  const reach = [
    contact.phone?.trim() ? `Ph: ${contact.phone.trim()}` : null,
    contact.email?.trim()
      ? `Email: ${contact.email.trim().toLowerCase()}`
      : null,
  ].filter(Boolean);
  const site = websiteUrl(contact.website);
  return [
    regd ? `Regd. Office: ${regd}` : null,
    office('Corp. Office', contact.corporateOffice),
    office('Branch Office', contact.branchOffice),
    reach.length ? reach.join('  |  ') : null,
    // On its own line: joined to the email it broke after "https://" in a narrow column.
    site ? `Website: ${site}` : null,
  ].filter((line): line is string => Boolean(line));
}

/**
 * An address on one line with each part once (2026-10-15, moved here in 055).
 *
 * The address is often typed in full — "28A, Gandhi Nagar, …, Deoli, Tonk, Rajasthan - 304804" —
 * and the city, state and PIN code are held beside it as well. Joined blindly it read
 * "…Rajasthan - 304804, Deoli, Rajasthan - 304804". A part the address already contains is left out.
 */
export function oneLineAddress(parts: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pinCode?: string | null;
}): string {
  const address = parts.address?.trim() ?? '';
  const has = (part: string) =>
    new RegExp(`\\b${escapeRegExp(part)}\\b`, 'i').test(address);
  const extra = [parts.city, parts.state]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part && !has(part));
  const place = [address, ...extra].filter(Boolean).join(', ');
  const pin = parts.pinCode?.trim() ?? '';
  if (!pin || has(pin)) return place;
  return place ? `${place} - ${pin}` : pin;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The band's measures, shared so every PDF's logo and name are the same size. */
export const HEADER = {
  logoWidth: 150,
  logoHeight: 72,
  nameSize: 17,
  lineSize: 9,
  gap: 16,
};

/** The same band for a ruled, dense format that repeats it on every page — the bill package. */
export const COMPACT_HEADER: typeof HEADER = {
  logoWidth: 120,
  logoHeight: 50,
  nameSize: 14,
  lineSize: 8,
  gap: 12,
};

/**
 * Draws the band — logo left, the name and contact lines beside it, a rule under both — from
 * (`x`, `y`) across `width`. Returns the y below the rule. A logo pdfkit cannot read prints the
 * name alone, as every renderer before this one did.
 */
export function drawCompanyHeader(
  doc: Doc,
  header: CompanyHeader,
  box: {
    x: number;
    y: number;
    width: number;
    regular: string;
    bold: string;
    measures?: typeof HEADER;
  },
): number {
  const { x, y, width } = box;
  const m = box.measures ?? HEADER;
  let textLeft = x;
  let logoBottom = y;
  if (header.logo) {
    try {
      // `openImage` is pdfkit's, missing from its type declarations.
      const image = (
        doc as unknown as {
          openImage(b: Buffer): { width: number; height: number };
        }
      ).openImage(header.logo);
      const scale = Math.min(
        m.logoWidth / image.width,
        m.logoHeight / image.height,
      );
      doc.image(image as unknown as Buffer, x, y, {
        width: image.width * scale,
        height: image.height * scale,
      });
      textLeft = x + image.width * scale + m.gap;
      logoBottom = y + image.height * scale;
    } catch {
      textLeft = x;
    }
  }
  const textWidth = x + width - textLeft;
  doc
    .font(box.bold)
    .fontSize(m.nameSize)
    .fillColor('#000000')
    .text(header.name.toUpperCase(), textLeft, y, { width: textWidth });
  doc.font(box.regular).fontSize(m.lineSize).fillColor('#222222');
  for (const line of header.lines) {
    doc.text(line, textLeft, doc.y + 1.5, { width: textWidth, lineGap: 1 });
  }
  const ruleAt = Math.max(doc.y, logoBottom) + 8;
  doc
    .lineWidth(1.2)
    .strokeColor('#333333')
    .moveTo(x, ruleAt)
    .lineTo(x + width, ruleAt)
    .stroke();
  doc.fillColor('#000000');
  return ruleAt + 12;
}
