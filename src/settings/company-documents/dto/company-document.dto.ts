import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsBoolean,
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

/**
 * A document kind the company invents for itself (017 FR-001b) — an MSME certificate, a
 * trade licence, a rent agreement.
 *
 * Deliberately **not** a general document-type creation DTO. There is no `code`: it is
 * derived from the name server-side, because a code is an internal identifier and asking
 * an administrator filing a certificate to invent one is asking the wrong person a
 * question they have no basis to answer. There is no `isRestricted` either — restriction
 * is FR-024's rule about regulated personal data and is settled in configuration, not by
 * whoever happens to be adding a kind. And there is no `scope`: this route creates
 * company-scoped kinds and nothing else, which is what keeps it from being general
 * document-type creation wearing a different permission.
 */
export class CreateCompanyDocumentKindDto {
  @ApiProperty({ example: 'MSME / Udyam registration' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({
    description:
      'Whether the paper lapses. When true, every upload of this kind must carry an ' +
      'expiry date (FR-004) and it becomes eligible for the expiry reminder (FR-005).',
  })
  @IsOptional()
  @IsBoolean()
  hasExpiry?: boolean;

  @ApiPropertyOptional({
    description: 'Whether it carries a reference number.',
  })
  @IsOptional()
  @IsBoolean()
  needsNumber?: boolean;
}
