import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ContractorComplianceStatus,
  ContractorDocumentType,
} from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateContractorDto {
  @ApiProperty({
    description: 'Must be a subcontractor or labour_contractor vendor',
  })
  @IsString()
  @IsNotEmpty()
  vendorId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  licenceNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  pfRegistration?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  esicRegistration?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  bocwRegistration?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  insurancePolicyNumber?: string;
}

/**
 * `vendorId` is intentionally absent: a profile is 1:1 with the vendor it was created
 * for, and allowing it to be repointed would silently move an entire compliance
 * history onto a different contractor.
 *
 * Written out rather than derived with `PartialType(CreateContractorDto)`, which
 * would inherit `vendorId` and then need it stripped again.
 */
export class UpdateContractorDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  licenceNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  pfRegistration?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  esicRegistration?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  bocwRegistration?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  insurancePolicyNumber?: string;
}

export class CreateContractorDocumentDto {
  @ApiProperty({ enum: ContractorDocumentType })
  @IsEnum(ContractorDocumentType)
  documentType: ContractorDocumentType;

  @ApiProperty({ description: 'Base64-encoded file content' })
  @IsString()
  @IsNotEmpty()
  file: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;

  @ApiPropertyOptional({ description: 'MIME type of the decoded content' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contentType?: string;

  @ApiPropertyOptional({ description: 'ISO date; drives the expiry warning' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class ListContractorsDto {
  @ApiPropertyOptional({ enum: ContractorComplianceStatus })
  @IsOptional()
  @IsEnum(ContractorComplianceStatus)
  complianceStatus?: ContractorComplianceStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}
