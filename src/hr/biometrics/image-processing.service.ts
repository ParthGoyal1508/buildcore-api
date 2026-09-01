import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Sharp } from 'sharp';

/**
 * sharp's `types` field points at its ESM declarations (`index.d.mts`), which this
 * project's node10 module resolution picks even though we compile to CommonJS — so
 * the callable is not reachable through any `import` form here: `import * as` is
 * not callable, and a default import would emit `sharp_1.default`, which the CJS
 * build does not define. A typed `require` keeps full typing on the chained calls
 * without changing module resolution for the rest of the codebase.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: (input?: Buffer) => Sharp = require('sharp');
import type { WorkspaceConfig } from '../../common/configs/config.interface';

/** Raw pixel data plus its dimensions — what tfjs needs to build a tensor. */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

/**
 * Every transformation applied to a photo between upload and storage.
 *
 * Two jobs, one dependency (constitution v1.4.0). Decoding, because face-api runs
 * on the WASM backend and so has no native image decoder available to it. And
 * re-encoding, because a modern phone camera produces multi-megabyte images and
 * storing those verbatim is what turns a punch photo into a storage bill.
 */
@Injectable()
export class ImageProcessingService {
  private readonly workspace: WorkspaceConfig;

  constructor(configService: ConfigService) {
    this.workspace = configService.get<WorkspaceConfig>('workspace');
  }

  /**
   * Decodes to raw RGB pixels for inference.
   *
   * Three channels, not four: an alpha channel carries no information a face
   * matcher uses, and passing RGBA where RGB is expected silently shifts every
   * pixel's colour values.
   */
  async decodeToRaw(photo: Buffer): Promise<RawImage> {
    const { data, info } = await sharp(photo)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      data,
      width: info.width,
      height: info.height,
      channels: info.channels,
    };
  }

  /** Compresses an enrolment photo — larger and cleaner, since descriptor quality
   * depends on it and it is written once per employee. */
  async compressEnrolmentPhoto(photo: Buffer): Promise<Buffer> {
    const { maxDimension, jpegQuality } =
      this.workspace.imageProcessing.enrolment;
    return this.compress(photo, maxDimension, jpegQuality);
  }

  /** Compresses a punch photo — smaller, since it only has to be good enough for a
   * human reviewing an exception. */
  async compressPunchPhoto(photo: Buffer): Promise<Buffer> {
    const { maxDimension, jpegQuality } = this.workspace.imageProcessing.punch;
    return this.compress(photo, maxDimension, jpegQuality);
  }

  /**
   * Compresses a reimbursement receipt.
   *
   * Reuses the punch profile deliberately: like a punch photo, a receipt only has
   * to stay legible to a human reviewing it, and the same pass is what strips the
   * EXIF a phone camera embeds — including the GPS coordinates of wherever the
   * receipt was photographed, which this feature has no business persisting.
   */
  async compressReceipt(photo: Buffer): Promise<Buffer> {
    return this.compressPunchPhoto(photo);
  }

  private async compress(
    photo: Buffer,
    maxDimension: number,
    quality: number,
  ): Promise<Buffer> {
    return (
      sharp(photo)
        // `withoutEnlargement` so an already-small photo is never upscaled — that
        // would add bytes and no detail. `inside` preserves aspect ratio, which
        // matters because a stretched face is a distorted face.
        .resize({
          width: maxDimension,
          height: maxDimension,
          fit: 'inside',
          withoutEnlargement: true,
        })
        // Rotate first, per the EXIF orientation flag, *before* that metadata is
        // discarded below — otherwise a portrait photo from a phone is stored
        // sideways, and a sideways face is one a reviewer cannot verify.
        .rotate()
        // Discards ALL metadata, which is the point rather than a side effect:
        // phone cameras embed GPS coordinates in EXIF, and this feature already
        // stores validated, audited coordinates in their own columns. Keeping the
        // EXIF copy would persist location PII outside that audited path
        // (Principle IV, constitution v1.4.0).
        .jpeg({ quality, mozjpeg: true })
        .toBuffer()
    );
  }
}
