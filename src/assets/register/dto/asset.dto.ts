import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { AssetStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAssetDto {
  @ApiPropertyOptional({
    description:
      'Leave empty to allocate the next code from the company ASSETS series',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  assetCode?: string;

  @ApiProperty({ example: 'Hilti TE 60 rotary hammer' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @ApiProperty({ description: 'An existing AssetCategory in the same company' })
  @IsString()
  @IsNotEmpty()
  categoryId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  manufacturer?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  modelNumber?: string;

  @ApiPropertyOptional({
    description:
      'Serialised categories only, and unique within the company (FR-008)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  serialNumber?: string;

  @ApiPropertyOptional({
    default: 1,
    description:
      'Bulk categories only. A serialised asset is one physical unit and rejects ' +
      'anything but 1 (FR-004).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity?: number;

  @ApiPropertyOptional({ example: 'NOS' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unitOfMeasure?: string;

  @ApiPropertyOptional({ example: '2026-04-01' })
  @IsOptional()
  @IsISO8601()
  purchaseDate?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  purchaseCost?: number;

  @ApiProperty({
    example: '2026-04-01',
    description:
      'When depreciation starts. Must be on or after purchaseDate (FR-019).',
  })
  @IsISO8601()
  capitalisationDate!: string;

  @ApiPropertyOptional({
    description: 'Defaults to the category’s rate at registration',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  depreciationRatePercent?: number;

  @ApiPropertyOptional({
    description: 'Defaults to the category’s useful life',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  usefulLifeYears?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  salvageValue?: number;

  @ApiPropertyOptional({ description: 'An existing vendor' })
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiPropertyOptional({
    description:
      'The recorded purchase this asset was acquired through (FR-038)',
  })
  @IsOptional()
  @IsString()
  purchaseId?: string;

  @ApiProperty({ description: 'Where the asset starts life' })
  @IsString()
  @IsNotEmpty()
  currentSiteId!: string;

  @ApiPropertyOptional({
    description: 'Best-first condition grade at registration',
  })
  @IsOptional()
  @IsString()
  currentConditionGradeId?: string;
}

export class UpdateAssetDto extends PartialType(CreateAssetDto) {
  @ApiPropertyOptional({
    enum: AssetStatus,
    description:
      'Checked against the status machine (FR-007). `allocated` and `in_transit` ' +
      'are set by allocation and transfer, never here.',
  })
  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;
}

export class ListAssetsDto {
  @ApiPropertyOptional({ description: 'Matches name, code or serial number' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  custodianId?: string;

  @ApiPropertyOptional({ enum: AssetStatus })
  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;

  @ApiPropertyOptional({
    description: 'Only assets whose next inspection is already due',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  inspectionDue?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

/**
 * Base64-in-JSON rather than `multipart/form-data`, for the reason
 * `UploadEquipmentDocumentDto` documents: every other document upload in this
 * codebase takes the file this way, and a second convention would mean a second
 * interceptor and a second size guard for no benefit.
 */
export class UploadAssetDocumentDto {
  @ApiProperty({ description: 'An existing AssetDocType in the same company' })
  @IsString()
  @IsNotEmpty()
  docTypeId!: string;

  @ApiProperty({ description: 'Base64-encoded file content' })
  @IsString()
  @IsNotEmpty()
  file!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contentType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  documentNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  issueDate?: string;

  @ApiPropertyOptional({ description: 'Drives the doc type’s expiry reminder' })
  @IsOptional()
  @IsISO8601()
  expiryDate?: string;
}
