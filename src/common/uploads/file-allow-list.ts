import { UnsupportedMediaTypeException } from '@nestjs/common';

import { detectContentType, type DetectedType } from '../storage/file-type';

/**
 * What an uploaded file is allowed to be, decided by its bytes (036 B5).
 *
 * Most document uploads stored whatever `contentType` the client declared and served it back —
 * so an HTML page declared as `image/png` came back as `text/html` to whoever opened it. This
 * reads the file's own signature with `detectContentType` and refuses anything not on the list,
 * and the **detected** type is what callers store and serve.
 */
export const PDF = 'application/pdf';
export const JPEG = 'image/jpeg';
export const PNG = 'image/png';
export const WEBP = 'image/webp';
export const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Photos only — for fields that are always a picture. */
export const IMAGE_TYPES: readonly string[] = [JPEG, PNG, WEBP];

/** The default for a document upload: PDF, the three photo formats, and Office xlsx/docx. */
export const DOCUMENT_TYPES: readonly string[] = [
  PDF,
  JPEG,
  PNG,
  WEBP,
  XLSX,
  DOCX,
];

/** The stable code an unsupported file is refused with. */
export const FILE_TYPE_NOT_ALLOWED = 'FILE_TYPE_NOT_ALLOWED';

const LABELS: Record<string, string> = {
  [PDF]: 'PDF',
  [JPEG]: 'JPEG',
  [PNG]: 'PNG',
  [WEBP]: 'WebP',
  [XLSX]: 'Excel (.xlsx)',
  [DOCX]: 'Word (.docx)',
};

/**
 * Returns the file's detected type, or refuses it with 415 `FILE_TYPE_NOT_ALLOWED`.
 *
 * ```ts
 * const bytes = decodeBase64Upload(dto.file, 'The NOC file');
 * const type = assertAllowedFileType(bytes);            // DOCUMENT_TYPES by default
 * await storage.put('noc-documents', bytes, type.contentType);
 * ```
 */
export function assertAllowedFileType(
  bytes: Buffer,
  allowed: readonly string[] = DOCUMENT_TYPES,
  label = 'The file',
): DetectedType {
  const detected = detectContentType(bytes);
  if (detected && allowed.includes(detected.contentType)) {
    return detected;
  }
  const names = allowed.map((t) => LABELS[t] ?? t).join(', ');
  throw new UnsupportedMediaTypeException({
    statusCode: 415,
    code: FILE_TYPE_NOT_ALLOWED,
    message: `${label} is not a supported type. Upload one of: ${names}.`,
    allowed,
  });
}
