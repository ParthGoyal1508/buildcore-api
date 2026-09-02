import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * One employee document upload (005 US2).
 *
 * The file arrives base64-encoded in the body rather than as multipart, matching how
 * 003 accepts biometric photos — one transport for every blob this API takes, so the
 * encryption and storage path is identical regardless of what is being uploaded.
 */
export class UploadEmployeeDocumentDto {
  @ApiProperty({ description: '`settings.DocumentType.id` this document satisfies.' })
  @IsString()
  @IsNotEmpty()
  documentTypeId: string;

  @ApiProperty({ description: 'Base64-encoded file contents.' })
  @IsString()
  @IsNotEmpty()
  file: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @IsNotEmpty()
  contentType: string;

  @ApiPropertyOptional({
    description: 'Required when the document type sets `needsNumber`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentNumber?: string;

  @ApiPropertyOptional({
    description: 'YYYY-MM-DD. Required when the document type sets `hasExpiry`.',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
