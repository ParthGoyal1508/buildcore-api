import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { IsBase64Payload } from '../../../common/uploads/base64-payload';

/**
 * The company's printed letterhead (2026-10-11).
 *
 * Base64 in the body rather than multipart, matching every other upload in this
 * repository — see `project-document-upload.controller.ts` and `AddDwrAttachmentDto`.
 *
 * **No `contentType`.** It is detected from the bytes, for the reason the DWR attachment
 * DTO records: a client's `Content-Type` is a guess made from a file extension, and a
 * wrong one here is a letterhead pdfkit refuses to decode — which renders every letter in
 * the company on plain paper, silently.
 */
export class SetLetterheadDto {
  @ApiProperty({
    description:
      'The letterhead image, base64-encoded. A **full page** — header, blank middle and ' +
      'footer — as the pre-printed stationery is, not a header strip: the renderer draws ' +
      'it to the page edges and lays the body inside the clear band.',
  })
  @IsString()
  @IsNotEmpty()
  @IsBase64Payload()
  data!: string;
}
