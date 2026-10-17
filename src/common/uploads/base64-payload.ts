import { BadRequestException } from '@nestjs/common';
import {
  ValidateBy,
  ValidationOptions,
  buildMessage,
  isBase64,
} from 'class-validator';

import { assertUploadSize, MAX_UPLOAD_BYTES } from './upload-limits';

/** An optional `data:<type>;base64,` prefix, as a browser's `FileReader` produces. */
const DATA_URL_PREFIX = /^data:[^;,]+;base64,/;

/** The constraint name, read by `large-body.ts` to find the routes that carry files. */
export const IS_BASE64_PAYLOAD = 'isBase64Payload';

/**
 * `@IsBase64()` that also accepts a data URL (036 B11).
 *
 * The photo routes (punch, enrolment, labour) have always accepted `data:image/jpeg;base64,…`
 * because that is what a canvas snapshot is, and `@IsBase64()` would refuse it. Use this on any
 * base64 field whose clients might send either; use `@IsBase64()` where only bare base64 has ever
 * been accepted.
 *
 * Either decorator marks the field as a file, which is what routes the request to the large body
 * limit — see `large-body.ts`.
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
          isBase64(value.replace(DATA_URL_PREFIX, '')),
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
