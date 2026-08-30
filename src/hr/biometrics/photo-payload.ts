import { BadRequestException } from '@nestjs/common';

/** Strips an optional `data:image/jpeg;base64,` prefix. */
const DATA_URL_PREFIX = /^data:image\/[a-zA-Z+]+;base64,/;

/**
 * Decodes a client-supplied base64 photo into bytes.
 *
 * Validates that the result actually looks like an image rather than trusting the
 * declared type: `Buffer.from(x, 'base64')` never throws — it silently skips
 * characters it cannot decode — so without a magic-number check, arbitrary text
 * would sail through as a zero-detection "photo" and surface much later as a
 * confusing face-detection failure.
 */
export function decodePhotoPayload(payload: string, label: string): Buffer {
  const base64 = payload.replace(DATA_URL_PREFIX, '').trim();
  if (base64.length === 0) {
    throw new BadRequestException(`${label} is empty.`);
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) {
    throw new BadRequestException(`${label} is not valid base64 image data.`);
  }
  if (!looksLikeImage(bytes)) {
    throw new BadRequestException(
      `${label} is not a recognised image (expected JPEG, PNG, or WebP).`,
    );
  }
  return bytes;
}

/** Magic-number sniff for the formats a phone camera produces. */
function looksLikeImage(bytes: Buffer): boolean {
  if (bytes.length < 12) {
    return false;
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return true;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return true;
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return true;
  }
  return false;
}
