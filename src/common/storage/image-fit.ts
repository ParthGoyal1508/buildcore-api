import type { Sharp, SharpOptions } from 'sharp';

/**
 * sharp's `types` field points at its ESM declarations, which this project's node10 module
 * resolution picks even though we compile to CommonJS — so the callable is not reachable through
 * any `import` form here. `ImageProcessingService` records the full reasoning; this is the same
 * typed `require` for the same reason.
 */
type SharpFactory = (input?: Buffer, options?: SharpOptions) => Sharp;
// The disable must sit on the same line as the `require`, so the signature is a named type rather
// than an inline one prettier would wrap across four lines and out from under this comment.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: SharpFactory = require('sharp');

/** A picture ready to be placed in a document, with the size it should be drawn at. */
export interface FittedImage {
  /** JPEG bytes, whatever went in. */
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Scales a photograph down to fit a box, and reports the size it came out.
 *
 * ## Why the dimensions are the point
 *
 * A spreadsheet cannot measure an image. `exceljs` places one either stretched across a cell range
 * or at an explicit pixel size, and both distort a photograph unless the caller already knows its
 * proportions — a portrait phone photo squashed into a landscape box is the usual result. So this
 * returns what it produced rather than only the bytes, which is the one thing
 * `ImageProcessingService.compress` does not: that service exists to shrink a photo on its way
 * into storage, where nothing has to lay it out afterwards.
 *
 * ## `.rotate()` before anything else
 *
 * A phone writes the orientation it was held at into EXIF and stores the pixels unrotated. Reading
 * that flag is what stops every portrait photograph arriving in the document on its side — the
 * same reason `ImageProcessingService` rotates, and the failure is far more visible here, where
 * the picture is printed rather than matched.
 *
 * Returns `null` for anything sharp cannot decode — a PDF, a corrupt file, a format libvips was
 * built without. The caller names those rather than embedding them, which is the honest outcome:
 * a document that silently omits an attachment is a document that disagrees with the screen.
 */
export async function fitImage(
  bytes: Buffer,
  maxDimension: number,
  jpegQuality: number,
): Promise<FittedImage | null> {
  try {
    const { data, info } = await sharp(bytes, {
      // **Decode what can be decoded.** sharp's default refuses an image that produces any
      // libvips warning — a truncated JPEG, a PNG with a bad chunk checksum — and a phone
      // photograph that travelled through a chat app and a flaky upload is routinely one of
      // those. The browser shows it, the report screen shows it, and a form that alone refused
      // to would read as evidence that was never filed. This path displays a picture; nothing
      // downstream trusts its bytes.
      failOn: 'none',
    })
      .rotate()
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        // An already-small photograph is never blown up: that adds bytes and no detail.
        withoutEnlargement: true,
      })
      // JPEG whatever arrived, so the document carries one format and the caller needs no
      // per-image branch. `exceljs` embeds png, jpeg and gif; converting removes the question.
      .jpeg({ quality: jpegQuality })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}
