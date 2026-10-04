import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Staging a document before its project exists (017 FR-009b). */
export class StageProjectDocumentDto {
  @ApiPropertyOptional({
    description:
      'The `DocumentType` this document satisfies. Omit for a supplementary document — but note ' +
      'that a supplementary staged document satisfies no mandatory kind, so it cannot unblock a ' +
      'creation on its own.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  documentTypeId?: string;

  @ApiProperty({
    description:
      "The kind's label as the uploader sees it, kept so a refusal can name the kind even if the " +
      'type is renamed between staging and creation.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  documentType: string;

  @ApiProperty({ description: 'The file, base64-encoded.' })
  @IsBase64()
  data: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @MaxLength(100)
  contentType: string;

  @ApiPropertyOptional({
    description:
      "The uploader's own file name, kept so the download is what they recognise rather than " +
      '`<kind>-<id>` with no extension. Optional: a document filed before 2026-10-04 has none, ' +
      'and the download sniffs the stored bytes for an extension in that case.',
    example: 'Tender — Whitefield Phase II.pdf',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}

/** Filing a document against an existing project (017 FR-008a). */
export class UploadProjectDocumentDto extends StageProjectDocumentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}
