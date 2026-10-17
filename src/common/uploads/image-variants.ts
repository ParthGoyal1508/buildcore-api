import type { Sharp, SharpOptions } from 'sharp';

/** See `image-fit.ts` for why sharp is reached through a typed `require`. */
type SharpFactory = (input?: Buffer, options?: SharpOptions) => Sharp;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: SharpFactory = require('sharp');

/**
 * Upload-time image compression and a list thumbnail (036 B6).
 *
 * Phone photographs arrive at 4000 px and 5–8 MB, and were stored and served at that size — a
 * list of ten DWR photos was a 60 MB page. This shrinks a picture once, on the way into storage,
 * to a size that still reads every word of a photographed permit, and makes a small thumbnail for
 * lists.
 *
 * - **Main image:** longest edge at most {@link MAX_IMAGE_DIMENSION} px, JPEG quality
 *   {@link IMAGE_QUALITY} (or WebP). EXIF orientation applied, metadata (GPS included) dropped.
 * - **Thumbnail:** longest edge {@link THUMBNAIL_DIMENSION} px, same format.
 *
 * JPEG is the default rather than WebP because these images are also embedded in generated
 * Excel and PDF documents, and `exceljs` cannot embed WebP.
 *
 * Returns `null` for anything sharp cannot decode, and for a PDF or Office file — callers store
 * those unchanged. A compressed image that came out *larger* than the original (an already-small
 * PNG screenshot) is not used: the original is kept.
 */
export const MAX_IMAGE_DIMENSION = 2048;
export const THUMBNAIL_DIMENSION = 320;
export const IMAGE_QUALITY = 80;

export interface ImageVariant {
  data: Buffer;
  /** `image/jpeg` or `image/webp` for a re-encode; the original's type when it was kept. */
  contentType: string;
  width: number;
  height: number;
}

export interface CompressedImage {
  /** The image to store. The original bytes, re-labelled, when compressing did not help. */
  main: ImageVariant;
  thumbnail: ImageVariant;
  /** Whether `main` is a re-encode (true) or the untouched original (false). */
  compressed: boolean;
}

const COMPRESSIBLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function render(
  bytes: Buffer,
  dimension: number,
  format: 'jpeg' | 'webp',
  quality: number,
): Promise<ImageVariant> {
  const pipeline = sharp(bytes, { failOn: 'none' })
    .rotate()
    .resize({
      width: dimension,
      height: dimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    // A transparent PNG flattened onto white, not black, when it becomes a JPEG.
    .flatten({ background: '#ffffff' });
  const { data, info } = await (format === 'webp'
    ? pipeline.webp({ quality })
    : pipeline.jpeg({ quality, mozjpeg: true })
  ).toBuffer({ resolveWithObject: true });
  return {
    data,
    contentType: format === 'webp' ? 'image/webp' : 'image/jpeg',
    width: info.width,
    height: info.height,
  };
}

/**
 * Compresses an uploaded image and makes its thumbnail; `null` when `contentType` is not a
 * photo format or the bytes cannot be decoded.
 *
 * `contentType` should be the **detected** type (`assertAllowedFileType(...).contentType`).
 */
export async function compressImageUpload(
  bytes: Buffer,
  contentType: string,
  options: {
    format?: 'jpeg' | 'webp';
    maxDimension?: number;
    thumbnailDimension?: number;
    quality?: number;
  } = {},
): Promise<CompressedImage | null> {
  if (!COMPRESSIBLE.has(contentType)) return null;
  const format = options.format ?? 'jpeg';
  const quality = options.quality ?? IMAGE_QUALITY;
  try {
    const [main, thumbnail] = await Promise.all([
      render(
        bytes,
        options.maxDimension ?? MAX_IMAGE_DIMENSION,
        format,
        quality,
      ),
      render(
        bytes,
        options.thumbnailDimension ?? THUMBNAIL_DIMENSION,
        format,
        quality,
      ),
    ]);
    if (main.data.length >= bytes.length) {
      // Re-encoding made it bigger. Keep the original; it is already small.
      const meta = await sharp(bytes, { failOn: 'none' }).metadata();
      return {
        main: {
          data: bytes,
          contentType,
          width: meta.width ?? main.width,
          height: meta.height ?? main.height,
        },
        thumbnail,
        compressed: false,
      };
    }
    return { main, thumbnail, compressed: true };
  } catch {
    return null;
  }
}
