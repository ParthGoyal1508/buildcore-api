import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * One company document being uploaded (017 FR-001, FR-004).
 *
 * A DTO class rather than loose `@Body()` fields, mandatory under Principle II even
 * though the shape is small — this codebase has already shipped endpoints whose params
 * went unvalidated, and `data` here is bytes that get written to object storage.
 *
 * Base64 rather than multipart deliberately: the web client has no FormData anywhere
 * (feature 015 established that punch photos travel as base64 in JSON), so accepting
 * multipart here would mean a second transport for one endpoint.
 */
export class UploadCompanyDocumentDto {
  @ApiProperty({ description: 'The `DocumentType` this document satisfies.' })
  @IsString()
  @MinLength(1)
  documentTypeId: string;

  @ApiProperty({ description: 'The file, base64-encoded.' })
  @IsBase64()
  data: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @MaxLength(100)
  contentType: string;

  @ApiPropertyOptional({
    description:
      'The number on the document — GSTIN, PAN, TAN — when the kind carries one.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentNumber?: string;

  @ApiPropertyOptional({
    description:
      'Required when the kind expires (`DocumentType.hasExpiry`). The service enforces ' +
      'that, not this DTO: the requirement depends on the kind, which a field-level ' +
      'validator cannot see.',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
