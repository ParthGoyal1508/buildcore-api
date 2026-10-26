import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  EquipmentOwnership,
  EquipmentStatus,
  PowerSource,
  RegistrationKind,
  RegistrationStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsBase64Payload } from '../../../common/uploads/base64-payload';

import {
  EQUIPMENT_YEAR_MAX,
  EQUIPMENT_YEAR_MIN,
} from '../../constants/plant.constants';

/**
 * One registration paper of the vehicle register (2026-10-15): RC, insurance, fitness, road tax,
 * permit or pollution — held with its expiry, not applicable, or valid for life.
 */
export class RegistrationItemDto {
  @ApiProperty({ enum: RegistrationKind })
  @IsEnum(RegistrationKind)
  kind!: RegistrationKind;

  @ApiProperty({ enum: RegistrationStatus })
  @IsEnum(RegistrationStatus)
  status!: RegistrationStatus;

  @ApiPropertyOptional({
    example: '2026-07-01',
    description: 'When the paper was issued. Ignored for a paper that is not applicable.',
  })
  @IsOptional()
  @IsISO8601()
  issuedAt?: string;

  @ApiPropertyOptional({ example: '2027-06-30' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Policy, permit or certificate number' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  number?: string;
}

export class CreateEquipmentDto {
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
  @MaxLength(100)
  categoryId!: string;

  @ApiProperty({ enum: EquipmentOwnership })
  @IsEnum(EquipmentOwnership)
  ownership!: EquipmentOwnership;

  @ApiPropertyOptional({
    description: 'The hire vendor. Required when ownership is `hired`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string;

  @ApiProperty({ enum: PowerSource })
  @IsEnum(PowerSource)
  powerSource!: PowerSource;

  @ApiPropertyOptional({ example: '2024-06-15' })
  @IsOptional()
  @IsISO8601()
  purchaseDate?: string;

  @ApiPropertyOptional({
    description:
      'The year the machine was built — the last part of its code. Not the purchase ' +
      'year: a 2015 excavator bought in 2024 is a 2015 machine. Omitted, the code ' +
      'falls back to the purchase year and then to the current one.',
    example: 2027,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(EQUIPMENT_YEAR_MIN)
  @Max(EQUIPMENT_YEAR_MAX)
  manufacturingYear?: number;

  @ApiPropertyOptional({
    description: 'Rupees. Feeds owned-equipment depreciation.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
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
  @MaxLength(100)
  deployedSiteId?: string;

  @ApiPropertyOptional({
    description: 'Opening meter reading at registration. Defaults to 0.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  currentReading?: number;

  // ── Registration details (2026-10-15), from the Equipment Master List ──

  @ApiPropertyOptional({ example: 'JCB', description: 'Brand name' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  make?: string;

  @ApiPropertyOptional({ example: 'JCB3DX' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  model?: string;

  @ApiPropertyOptional({
    example: 'RJ26-SD-6986',
    description:
      'Vehicle number, or a serial number for a machine off the road',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  registrationNo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  engineNo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  chassisNo?: string;

  @ApiPropertyOptional({ description: 'Who the machine was bought from' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  supplierName?: string;

  @ApiPropertyOptional({
    description: 'The "Firm" the RC stands in, when not the company itself',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  registeredOwner?: string;

  @ApiPropertyOptional({ description: 'Operator / in-charge' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  operatorName?: string;

  @ApiPropertyOptional({ description: 'Where it is, or who has it' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remarks?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsISO8601()
  lastServiceDate?: string;

  @ApiPropertyOptional({
    type: [RegistrationItemDto],
    description:
      'The registration papers. Each kind given replaces that kind; kinds left out are kept.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => RegistrationItemDto)
  registration?: RegistrationItemDto[];

  @ApiPropertyOptional({
    description:
      'Service schedule: a periodic service every this many hours (or km, on a km meter). ' +
      'On registration only — afterwards, schedules are kept under Services.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(1)
  @Max(2_147_483_647)
  serviceInterval?: number;
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
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
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
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
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
  @MaxLength(100)
  docTypeId!: string;

  @ApiProperty({ description: 'Base64-encoded file content' })
  @IsBase64Payload()
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

/** A photo of the machine (036 K14). JPEG, PNG or WebP; compressed again on the server. */
export class UploadEquipmentPhotoDto {
  @ApiProperty({ description: 'Base64-encoded JPEG, PNG or WebP image' })
  @IsBase64Payload()
  file!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;

  @ApiPropertyOptional({
    description:
      "Make this the machine's main photo. The first photo of a machine always is.",
  })
  @IsOptional()
  @IsBoolean()
  makeMain?: boolean;
}

export class EquipmentPhotoFileQueryDto {
  @ApiPropertyOptional({ enum: ['thumb', 'full'], default: 'full' })
  @IsOptional()
  @IsIn(['thumb', 'full'])
  size?: 'thumb' | 'full';
}

/** The client's Equipment Master List, as a base64 `.xlsx` (2026-10-15). */
export class ImportEquipmentDto {
  @ApiProperty({ description: 'Base64-encoded .xlsx workbook' })
  @IsBase64Payload()
  file!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;
}

/** The vehicle register's filters — the register list's own, unpaged. */
export class EquipmentRegisterQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
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
  @MaxLength(100)
  companyId?: string;
}
