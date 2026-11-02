import { BadRequestException } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBodyOptions } from '@nestjs/swagger';

import { looksLikeImage } from '../../hr/biometrics/photo-payload';

/** At most an enrolment's four frames, with one to spare. */
const MAX_FRAMES = 5;
/** A frame is ~60 KB from the app; 3 MB leaves room for any camera without inviting abuse. */
const MAX_FRAME_BYTES = 3 * 1024 * 1024;

/**
 * The frames of a liveness capture (057), sent as `multipart/form-data` files named `frames`, in
 * the challenge's step order. Binary rather than base64 in JSON: a punch is now three photos, and
 * base64 would add a third to every one of them on site mobile data. Held in memory — they are
 * small, and are compressed and stored (or discarded) within the request.
 */
export const LivenessFramesInterceptor = () =>
  FilesInterceptor('frames', MAX_FRAMES, {
    limits: { fileSize: MAX_FRAME_BYTES, files: MAX_FRAMES },
  });

/** What multer hands over per file; only the bytes are read (no `@types/multer` needed for that). */
export interface UploadedFrame {
  buffer: Buffer;
}

/** The uploaded frames as buffers, each checked to be an image. */
export function framesFrom(files: UploadedFrame[] | undefined): Buffer[] {
  if (!files || files.length === 0) {
    throw new BadRequestException({
      code: 'LIVENESS_FRAMES_MISSING',
      message:
        'No photos were received. This app version is out of date — reload it and try again.',
    });
  }
  return files.map((file, i) => {
    if (!looksLikeImage(file.buffer)) {
      throw new BadRequestException(
        `Photo ${
          i + 1
        } is not a recognised image (expected JPEG, PNG, or WebP).`,
      );
    }
    return file.buffer;
  });
}

/** Swagger for a multipart body: the DTO's fields plus the `frames` files. */
export function livenessMultipartBody(
  fields: Record<string, { type: string; format?: string; enum?: string[] }>,
  required: string[],
): ApiBodyOptions {
  return {
    schema: {
      type: 'object',
      required: [...required, 'frames'],
      properties: {
        ...fields,
        frames: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description:
            'The capture, one JPEG per step of the liveness challenge, in its order.',
        },
      },
    },
  };
}
