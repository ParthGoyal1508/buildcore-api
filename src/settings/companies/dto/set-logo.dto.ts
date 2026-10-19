import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { IsBase64Payload } from '../../../common/uploads/base64-payload';

/**
 * The company's logo — the mark shown wherever the product's own otherwise is
 * (2026-10-12).
 *
 * Base64 in the body rather than multipart, matching every other upload in this
 * repository, and with no `contentType` for the reason `SetLetterheadDto` beside it
 * records: a client's `Content-Type` is a guess made from a file extension, and this one
 * is detected from the bytes.
 */
export class SetLogoDto {
  @ApiProperty({
    description:
      'The logo image, base64-encoded. Drawn at roughly 32 pixels tall against a ' +
      'white sidebar and a blue panel, so a wide, short mark reads best.',
  })
  @IsString()
  @IsNotEmpty()
  @IsBase64Payload()
  data!: string;
}
