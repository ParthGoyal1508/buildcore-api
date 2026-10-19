import { BadRequestException } from '@nestjs/common';
import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

import { assertUploadSize, MAX_UPLOAD_BYTES } from './upload-limits';

/** An optional `data:<type>;base64,` prefix, as a browser's `FileReader` produces. */
const DATA_URL_PREFIX = /^data:[^;,]+;base64,/;

/** Base64 alphabet with up to two `=` of padding — a single character class, no nesting. */
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Whether `value` is standard base64, in time and stack linear in its length.
 *
 * **Not `validator`'s `isBase64`**, which class-validator's `@IsBase64()` uses: its pattern nests a
 * quantified group, and on a 10 MB file (a ~13 MB string) V8's regex engine runs out of stack —
 * `RangeError: Maximum call stack size exceeded`, a 500, on exactly the uploads the 10 MB promise
 * covers. Found by the 036 e2e suite uploading a 9 MB PDF.
 */
export function isBase64String(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64_CHARS.test(value);
}

/** The constraint name, read by `large-body.ts` to find the routes that carry files. */
export const IS_BASE64_PAYLOAD = 'isBase64Payload';

/**
 * Base64 file data, optionally as a data URL (036 B11). **Use this, not `@IsBase64()`**, on file
 * fields: see `isBase64String` for why class-validator's own fails on large files.
 *
 * It also accepts a `data:image/jpeg;base64,…` prefix, which the photo routes (punch, enrolment,
 * labour) have always taken because that is what a canvas snapshot is.
 *
 * Marking a field with it is also what routes the request to the upload body limit — see
 * `large-body.ts` (which still recognises a stray `@IsBase64()` too).
 */
export function IsBase64Payload(
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: IS_BASE64_PAYLOAD,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          value.length > 0 &&
          isBase64String(value.replace(DATA_URL_PREFIX, '')),
        defaultMessage: buildMessage(
          (each) => `${each}$property must be base64-encoded file data`,
          options,
        ),
      },
    },
    options,
  );
}

/**
 * Decodes a base64 (or data-URL) upload and enforces the shared size limit (036 B4).
 *
 * Refuses an empty payload with 400 and an oversize one with 413 `FILE_TOO_LARGE`.
 */
export function decodeBase64Upload(
  payload: string,
  label = 'The file',
  max = MAX_UPLOAD_BYTES,
): Buffer {
  const bytes = Buffer.from(payload.replace(DATA_URL_PREFIX, ''), 'base64');
  if (bytes.length === 0) {
    throw new BadRequestException(`${label} is empty.`);
  }
  assertUploadSize(bytes, label, max);
  return bytes;
}
