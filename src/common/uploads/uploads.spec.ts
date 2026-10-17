import { HttpException, Post, Body, Controller, Get } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBase64, IsString, ValidateNested, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import type { Sharp, SharpOptions } from 'sharp';

import {
  assertAllowedFileType,
  assertUploadSize,
  collectLargeBodyRoutes,
  compressImageUpload,
  decodeBase64Upload,
  dtoCarriesFile,
  FILE_TOO_LARGE,
  FILE_TYPE_NOT_ALLOWED,
  IMAGE_TYPES,
  IsBase64Payload,
  LargeBody,
  largeBodyMatcher,
  MAX_UPLOAD_BYTES,
  bodyParserErrors,
} from '.';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp: (options: SharpOptions) => Sharp = require('sharp');

const refusal = (fn: () => unknown): HttpException => {
  try {
    fn();
  } catch (e) {
    return e as HttpException;
  }
  throw new Error('expected a refusal');
};

const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');

describe('upload limits (036 B4)', () => {
  it('accepts exactly 10 MB of file and refuses a byte more with 413 FILE_TOO_LARGE', () => {
    expect(() =>
      assertUploadSize(Buffer.alloc(MAX_UPLOAD_BYTES)),
    ).not.toThrow();
    const error = refusal(() =>
      assertUploadSize(Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'The NOC file'),
    );
    expect(error.getStatus()).toBe(413);
    expect(error.getResponse()).toMatchObject({
      code: FILE_TOO_LARGE,
      message: expect.stringContaining('The limit is 10 MB'),
    });
  });

  it('decodes bare base64 and a data URL alike, and refuses an empty one', () => {
    const b64 = PDF.toString('base64');
    expect(decodeBase64Upload(b64)).toEqual(PDF);
    expect(decodeBase64Upload(`data:application/pdf;base64,${b64}`)).toEqual(
      PDF,
    );
    expect(refusal(() => decodeBase64Upload('')).getStatus()).toBe(400);
  });
});

describe('IsBase64Payload (036 B11)', () => {
  class Photo {
    @IsBase64Payload() photo!: string;
  }
  it.each([
    ['bare base64', 'aGVsbG8=', 0],
    ['a data URL', 'data:image/jpeg;base64,aGVsbG8=', 0],
    ['text', 'not base64 at all!', 1],
    ['empty', '', 1],
  ])('%s', async (_label, photo, errors) => {
    expect(await validate(plainToInstance(Photo, { photo }))).toHaveLength(
      errors,
    );
  });
});

describe('assertAllowedFileType (036 B5)', () => {
  it('returns the detected type, whatever the client declared', () => {
    expect(assertAllowedFileType(PDF).contentType).toBe('application/pdf');
  });

  it('refuses HTML dressed as a picture with 415', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const error = refusal(() => assertAllowedFileType(html));
    expect(error.getStatus()).toBe(415);
    expect(error.getResponse()).toMatchObject({ code: FILE_TYPE_NOT_ALLOWED });
  });

  it('honours a narrower list', () => {
    expect(
      refusal(() => assertAllowedFileType(PDF, IMAGE_TYPES)).getStatus(),
    ).toBe(415);
  });
});

describe('compressImageUpload (036 B6)', () => {
  it('shrinks a large photo to 2048 px and makes a 320 px thumbnail', async () => {
    const big = await sharp({
      create: {
        width: 4000,
        height: 3000,
        channels: 3,
        noise: { type: 'gaussian', mean: 128, sigma: 40 },
      },
    } as SharpOptions)
      .png()
      .toBuffer();

    const result = await compressImageUpload(big, 'image/png');

    expect(result).not.toBeNull();
    expect(result?.compressed).toBe(true);
    expect(result?.main.contentType).toBe('image/jpeg');
    expect(Math.max(result!.main.width, result!.main.height)).toBe(2048);
    expect(Math.max(result!.thumbnail.width, result!.thumbnail.height)).toBe(
      320,
    );
    expect(result!.main.data.length).toBeLessThan(big.length);
  });

  it('leaves a PDF alone', async () => {
    expect(await compressImageUpload(PDF, 'application/pdf')).toBeNull();
  });
});

describe('large body routes (036 B8)', () => {
  class Nested {
    @IsBase64() data!: string;
  }
  class WithNested {
    @ValidateNested() @Type(() => Nested) doc!: Nested;
  }
  class Plain {
    @IsString() name!: string;
  }
  @LargeBody()
  class Csv {
    @IsString() csv!: string;
  }

  it('finds a file field directly, through nesting, or by marker', () => {
    expect(dtoCarriesFile(Nested)).toBe(true);
    expect(dtoCarriesFile(WithNested)).toBe(true);
    expect(dtoCarriesFile(Csv)).toBe(true);
    expect(dtoCarriesFile(Plain)).toBe(false);
  });

  it('derives method + path from the controllers', () => {
    @Controller('things')
    class ThingsController {
      @Post(':id/upload') upload(@Body() _dto: WithNested) {
        return null;
      }
      @Post() create(@Body() _dto: Plain) {
        return null;
      }
      @Get(':id') read() {
        return null;
      }
    }
    const container = new Map([
      [
        'm',
        {
          controllers: new Map([
            [ThingsController, { metatype: ThingsController }],
          ]),
        },
      ],
    ]);
    const routes = collectLargeBodyRoutes(container as never);
    expect(routes).toEqual([{ method: 'POST', path: '/things/:id/upload' }]);

    const isLarge = largeBodyMatcher(routes);
    expect(isLarge('POST', '/things/abc/upload')).toBe(true);
    expect(isLarge('POST', '/things/abc/upload/')).toBe(true);
    expect(isLarge('PUT', '/things/abc/upload')).toBe(false);
    expect(isLarge('POST', '/things')).toBe(false);
    expect(isLarge('POST', '/things/abc/upload/extra')).toBe(false);
  });

  it('answers a parser refusal with the API error body', () => {
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    bodyParserErrors(
      { type: 'entity.too.large', status: 413 },
      {} as never,
      res as never,
      jest.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
  });
});
