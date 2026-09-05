import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { AssetTrackingMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// ── Asset categories ────────────────────────────────────────────────────────

export class CreateAssetCategoryDto {
  @ApiProperty({ example: 'Power Tools' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    enum: AssetTrackingMode,
    description:
      'serialised = one row per physical unit, with a serial number and a ' +
      'custodian. bulk = one row for the pool, with quantities held per site. ' +
      'Immutable once assets exist under the category (FR-003).',
  })
  @IsEnum(AssetTrackingMode)
  trackingMode!: AssetTrackingMode;

  @ApiPropertyOptional({
    default: 0,
    description: 'Straight-line depreciation, % per annum',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  depreciationRatePercent?: number;

  @ApiPropertyOptional({ default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  usefulLifeYears?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Allocating an asset in this category requires a custodian posted at the ' +
      'allocation site (FR-010)',
  })
  @IsOptional()
  @IsBoolean()
  custodyRequired?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'Requires inspectionIntervalDays when true (US1 scenario 2)',
  })
  @IsOptional()
  @IsBoolean()
  inspectionRequired?: boolean;

  @ApiPropertyOptional({ example: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  inspectionIntervalDays?: number;

  @ApiPropertyOptional({
    default: 50,
    description:
      'Cumulative repair cost above this share of purchase cost flags the asset',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  repairCostThresholdPercent?: number;
}

export class UpdateAssetCategoryDto extends PartialType(
  CreateAssetCategoryDto,
) {
  @ApiPropertyOptional({ description: 'Retire a category without deleting it' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ── Asset document types ────────────────────────────────────────────────────

export class CreateAssetDocTypeDto {
  @ApiProperty({ example: 'Insurance' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({
    default: 30,
    description:
      'Days before expiry at which a document of this type starts alerting',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  alertDays?: number;
}

export class UpdateAssetDocTypeDto extends PartialType(CreateAssetDocTypeDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ── Condition grades ────────────────────────────────────────────────────────

export class CreateConditionGradeDto {
  @ApiProperty({ example: 'Damaged' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    example: 5,
    description:
      'Ascending = worse. Drives dropdown order and the transfer receipt’s ' +
      'condition-discrepancy comparison.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  sequence!: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'A return or inspection at this grade sends the asset to repair',
  })
  @IsOptional()
  @IsBoolean()
  isDamaged?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: '... and at this grade, to scrapped',
  })
  @IsOptional()
  @IsBoolean()
  isScrap?: boolean;
}

export class UpdateConditionGradeDto extends PartialType(
  CreateConditionGradeDto,
) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
