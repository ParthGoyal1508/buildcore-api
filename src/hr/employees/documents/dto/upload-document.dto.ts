import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsBase64Payload } from '../../../../common/uploads/base64-payload';

/**
 * One employee document upload (005 US2).
 *
 * The file arrives base64-encoded in the body rather than as multipart, matching how
 * 003 accepts biometric photos — one transport for every blob this API takes, so the
 * encryption and storage path is identical regardless of what is being uploaded.
 */
export class UploadEmployeeDocumentDto {
  @ApiProperty({
    description: '`settings.DocumentType.id` this document satisfies.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  documentTypeId: string;

  @ApiProperty({ description: 'Base64-encoded file contents.' })
  @IsString()
  @IsNotEmpty()
  @IsBase64Payload()
  file: string;

  @ApiPropertyOptional({
    example: 'application/pdf',
    description:
      'Ignored since 036 F15: the type is detected from the bytes and that is what is stored. ' +
      'Still accepted so existing clients keep working.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contentType?: string;

  @ApiPropertyOptional({
    example: 'passport-scan.pdf',
    description: "The uploader's file name, kept for the download (036 F15).",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @ApiPropertyOptional({
    description: 'Required when the document type sets `needsNumber`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentNumber?: string;

  @ApiPropertyOptional({
    description:
      'YYYY-MM-DD. Required when the document type sets `hasExpiry`.',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
