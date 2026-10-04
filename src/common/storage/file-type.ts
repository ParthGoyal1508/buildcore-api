/**
 * What a stored file actually is, read from its first bytes.
 *
 * ## Why this exists
 *
 * Project and company documents were downloaded as `application/octet-stream` under a filename
 * with **no extension** — `Bill-of-quantities-cmu40n3…`. The browser cannot render a type it has
 * not been told, so a PDF opened as a wall of `%PDF-1.3 … endstream` in a text editor, and the
 * uploader's own file name was nowhere in it.
 *
 * Neither model stored the uploaded content type, even though both routes receive one. They do
 * now — but every document filed before that migration has `mimeType` null, and those are the
 * documents people are looking at today. Sniffing is what lets an existing document open
 * correctly without a backfill that could only guess anyway.
 *
 * ## Scope
 *
 * Deliberately a short list of signatures rather than a dependency. Every format here is one the
 * product actually receives — a tender, a scan, a photographed permit, a workbook — and each is
 * identified by bytes the format defines, not by a heuristic. Anything unrecognised returns
 * `null`, which the callers render as `application/octet-stream`: an honest "unknown" rather
 * than a guess that would make the browser render the wrong thing confidently.
 *
 * The one case this cannot resolve is legacy OLE2 (`.xls`, `.doc`, `.ppt`), which share a
 * container and one signature. Reported as the container, with the extension the client's own
 * tender files use, because the alternative is to pick one of three and be wrong twice.
 */
export interface DetectedType {
  contentType: string;
  /** Including the leading dot, so it can be appended to a name directly. */
  extension: string;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
/** The OLE2 compound-file header shared by legacy `.xls`, `.doc` and `.ppt`. */
const OLE2_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

/** How far into a ZIP container to look for the member names that identify an Office format. */
const ZIP_PEEK_BYTES = 4096;

export function detectContentType(bytes: Buffer): DetectedType | null {
  if (bytes.length < 8) return null;

  // PDF: "%PDF-"
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { contentType: 'application/pdf', extension: '.pdf' };
  }

  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { contentType: 'image/png', extension: '.png' };
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: '.jpg' };
  }

  // GIF: "GIF87a" or "GIF89a"
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) {
    return { contentType: 'image/gif', extension: '.gif' };
  }

  // WebP: "RIFF" ␣␣␣␣ "WEBP"
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { contentType: 'image/webp', extension: '.webp' };
  }

  // ZIP container: "PK\x03\x04". Every modern Office format is one, so the signature alone is
  // not an answer — the member names are. They appear in the local file headers near the front.
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    const head = bytes.subarray(0, ZIP_PEEK_BYTES).toString('latin1');
    if (head.includes('xl/')) {
      return {
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: '.xlsx',
      };
    }
    if (head.includes('word/')) {
      return {
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extension: '.docx',
      };
    }
    if (head.includes('ppt/')) {
      return {
        contentType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        extension: '.pptx',
      };
    }
    return { contentType: 'application/zip', extension: '.zip' };
  }

  if (bytes.subarray(0, 8).equals(OLE2_SIGNATURE)) {
    // `.xls` rather than `.doc` because this product receives tender workbooks, and the
    // extension only has to be right often enough to open the file in something sensible. The
    // content type stays the honest one: all three formats share this container.
    return { contentType: 'application/vnd.ms-excel', extension: '.xls' };
  }

  return null;
}

/** The extension a declared content type implies, for a file whose own name carries none. */
const EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/zip': '.zip',
  'application/vnd.ms-excel': '.xls',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    '.pptx',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

export function extensionFor(contentType: string | null): string | null {
  if (!contentType) return null;
  // `application/pdf; charset=binary` is a content type a client may legitimately send.
  const bare = contentType.split(';')[0].trim().toLowerCase();
  return EXTENSIONS[bare] ?? null;
}

/**
 * What to serve for a stored document: its type, and a name a person can open.
 *
 * `storedName` is the uploader's own file name where one was recorded. `storedType` is what the
 * uploader's browser declared. Sniffed bytes are consulted when either is missing, which is the
 * state of every document filed before the columns existed — and are preferred over a stored
 * type of `application/octet-stream`, because that is what a browser sends when it recognises
 * nothing and is not a claim about the file.
 */
export function describeStoredFile(input: {
  bytes: Buffer;
  storedName: string | null;
  storedType: string | null;
  /** Used when there is no stored name — the document's label and id, already sanitised. */
  fallbackName: string;
}): { filename: string; contentType: string } {
  const sniffed = detectContentType(input.bytes);
  const declared =
    input.storedType && input.storedType !== 'application/octet-stream'
      ? input.storedType
      : null;
  const contentType =
    declared ?? sniffed?.contentType ?? 'application/octet-stream';

  if (input.storedName && /\.[A-Za-z0-9]{1,8}$/.test(input.storedName)) {
    return { filename: input.storedName, contentType };
  }

  const extension = extensionFor(declared) ?? sniffed?.extension ?? '';
  return {
    filename: `${input.storedName || input.fallbackName}${extension}`,
    contentType,
  };
}
