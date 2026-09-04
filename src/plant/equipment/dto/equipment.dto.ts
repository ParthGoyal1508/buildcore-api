import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  EquipmentOwnership,
  EquipmentStatus,
  PowerSource,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBase64,
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

export class CreateEquipmentDto {
  @ApiPropertyOptional({
    description:
      "The yard's own plate or asset number. Omit to have one allocated from the " +
      'company EQUIPMENT series.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  code?: string;

  @ApiProperty({ example: 'JCB 3DX Backhoe Loader' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description: 'An existing EquipmentCategory in the same company',
  })
  @IsString()
  @IsNotEmpty()
  categoryId!: string;

  @ApiProperty({ enum: EquipmentOwnership })
  @IsEnum(EquipmentOwnership)
  ownership!: EquipmentOwnership;

  @ApiPropertyOptional({
    description: 'The hire vendor. Required when ownership is `hired`.',
  })
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiProperty({ enum: PowerSource })
  @IsEnum(PowerSource)
  powerSource!: PowerSource;

  @ApiPropertyOptional({ example: '2024-06-15' })
  @IsOptional()
  @IsISO8601()
  purchaseDate?: string;

  @ApiPropertyOptional({
    description: 'Rupees. Feeds owned-equipment depreciation.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  purchaseCost?: number;

  @ApiPropertyOptional({ description: 'Straight-line, % per annum' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  depreciationRate?: number;

  @ApiPropertyOptional({ description: 'Where the machine currently works' })
  @IsOptional()
  @IsString()
  deployedSiteId?: string;

  @ApiPropertyOptional({
    description: 'Opening meter reading at registration. Defaults to 0.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  currentReading?: number;
}

/**
 * `code` is absent: it identifies the machine to the yard, and renaming it would
 * detach every logbook entry, fuel entry and hire bill from the thing they describe.
 *
 * `status` is present but constrained — see `EquipmentService.update()`. It may be
 * set to `active` or `inactive`; `under_maintenance` is the maintenance job
 * lifecycle's to set and nobody else's (FR-002).
 */
export class UpdateEquipmentDto extends PartialType(CreateEquipmentDto) {
  @ApiPropertyOptional({
    enum: EquipmentStatus,
    description:
      '`under_maintenance` is refused with a 400 — open or close a maintenance ' +
      'job instead (FR-002).',
  })
  @IsOptional()
  @IsEnum(EquipmentStatus)
  status?: EquipmentStatus;
}

export class ListEquipmentDto {
  @ApiPropertyOptional({ description: 'Matches name or code' })
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

  @ApiPropertyOptional({ enum: EquipmentStatus })
  @IsOptional()
  @IsEnum(EquipmentStatus)
  status?: EquipmentStatus;

  @ApiPropertyOptional({ enum: EquipmentOwnership })
  @IsOptional()
  @IsEnum(EquipmentOwnership)
  ownership?: EquipmentOwnership;

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
 * Base64-in-JSON rather than the `multipart/form-data` the contract names.
 *
 * Every other document upload in this codebase — 005's employee documents, 007's
 * contractor documents, 009's purchase bills — takes the file as a base64 string in
 * an ordinary JSON body. Introducing a second upload convention for one module
 * would mean a second interceptor, a second size guard and a second set of client
 * code, for no benefit the contract actually asks for.
 */
export class UploadEquipmentDocumentDto {
  @ApiProperty({
    description: 'An existing EquipmentDocType in the same company',
  })
  @IsString()
  @IsNotEmpty()
  docTypeId!: string;

  @ApiProperty({ description: 'Base64-encoded file content' })
  @IsBase64()
  file!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;

  @ApiPropertyOptional({ default: 'application/octet-stream' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contentType?: string;

  @ApiPropertyOptional({
    description:
      'When the document lapses. Omit for a document that does not expire — it ' +
      'then never contributes to `expiryAlert`.',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
