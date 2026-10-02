import { ApiProperty } from '@nestjs/swagger';
import { IsBase64, IsString, MaxLength } from 'class-validator';

/**
 * The bank's returned transaction sheet (021 FR-008) — `bugs.md` item 8.
 *
 * Base64 in a JSON body rather than multipart, matching every other upload in this product (company
 * documents, signatories, payment proofs). One upload convention means one place where size limits,
 * content types and validation live, rather than two that disagree about which rejects what.
 */
export class UploadTransactionSheetDto {
  @ApiProperty({
    description:
      'The .xlsx the bank returned, base64-encoded. **Not** the sheet this product generated — ' +
      'the one that came back with the transfers confirmed.',
  })
  @IsBase64()
  data: string;

  @ApiProperty({
    example:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    description:
      'Recorded, not trusted. The parser opens the bytes as a workbook and refuses what it ' +
      'cannot open, so a wrong content type is at worst a wrong label on a file that still works.',
  })
  @IsString()
  @MaxLength(200)
  contentType: string;
}
