import { PayloadTooLargeException } from '@nestjs/common';

/**
 * The upload size limits, in one place (036 B4).
 *
 * ## Two numbers, because base64 costs a third
 *
 * The product promises "up to 10 MB" for every document and photo. Files travel as base64
 * inside a JSON body, and base64 turns every 3 bytes into 4 — so a 10 MB file is a ~13.4 MB
 * request. The old single 10 MB *body* limit therefore capped real files at about 7.5 MB, and an
 * 8 MB PDF met a raw `413 request entity too large` that no screen could explain.
 *
 * - {@link MAX_UPLOAD_BYTES} — the size of the **file**, decoded. What the UI and the API both
 *   promise, and what services check with {@link assertUploadSize}.
 * - {@link UPLOAD_REQUEST_BODY_LIMIT} — the size of the **request**, applied only to the routes
 *   that carry files (see `large-body.ts`). 10 MB × 4/3 plus room for the other fields.
 *
 * Every other route accepts {@link DEFAULT_REQUEST_BODY_LIMIT} (036 B8): nothing that is not a
 * file needs more, and a small ceiling everywhere else bounds what one request can make the
 * server buffer.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The same limit as a person reads it, for messages. */
export const MAX_UPLOAD_LABEL = '10 MB';

/** The request-body ceiling on upload routes. Env `MAX_REQUEST_BODY_SIZE` overrides. */
export const UPLOAD_REQUEST_BODY_LIMIT = '14mb';

/** The request-body ceiling on every other route. Env `DEFAULT_REQUEST_BODY_SIZE` overrides. */
export const DEFAULT_REQUEST_BODY_LIMIT = '100kb';

/** The stable code a too-large file is refused with, for the web to branch on. */
export const FILE_TOO_LARGE = 'FILE_TOO_LARGE';

/**
 * Refuses a decoded file over {@link MAX_UPLOAD_BYTES} (or `max`) with a 413 a person can act on.
 *
 * `label` names the file in the message — "The NOC file", "Photo 2".
 */
export function assertUploadSize(
  bytes: Buffer,
  label = 'The file',
  max = MAX_UPLOAD_BYTES,
): void {
  if (bytes.length <= max) return;
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  throw new PayloadTooLargeException({
    statusCode: 413,
    code: FILE_TOO_LARGE,
    message: `${label} is ${mb(bytes.length)}. The limit is ${
      max === MAX_UPLOAD_BYTES ? MAX_UPLOAD_LABEL : mb(max)
    }.`,
    maxBytes: max,
  });
}
