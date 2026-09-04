import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { MeterType } from '@prisma/client';
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

// ── Equipment categories ────────────────────────────────────────────────────

export class CreateEquipmentCategoryDto {
  @ApiProperty({ example: 'Excavator' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiProperty({
    enum: MeterType,
    description: 'What machines in this category meter: running hours, or km',
  })
  @IsEnum(MeterType)
  meterType!: MeterType;

  @ApiPropertyOptional({
    description:
      'Expected consumption per meter unit (litres/hour or litres/km). Omit ' +
      'rather than guess — an unset benchmark computes no variance, a wrong one ' +
      'flags every entry.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  fuelBenchmark?: number;

  @ApiPropertyOptional({
    default: 15,
    description:
      'How far past the benchmark a fuel entry may sit before it is flagged',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  fuelVarianceThresholdPercent?: number;

  @ApiPropertyOptional({
    default: 176,
    description: 'Denominator for utilisation %: 22 working days × 8 hours',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetHoursPerMonth?: number;
}

export class UpdateEquipmentCategoryDto extends PartialType(
  CreateEquipmentCategoryDto,
) {
  @ApiPropertyOptional({ description: 'Retire a category without deleting it' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ── Equipment document types ────────────────────────────────────────────────

export class CreateEquipmentDocTypeDto {
  @ApiProperty({ example: 'Insurance' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({
    default: 30,
    description:
      'Days before expiry at which a document of this type starts flagging ' +
      '`expiryAlert` on the equipment register',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  alertDays?: number;
}

export class UpdateEquipmentDocTypeDto extends PartialType(
  CreateEquipmentDocTypeDto,
) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ── Hire rates ──────────────────────────────────────────────────────────────

export class CreateHireRateDto {
  @ApiProperty({
    description: 'An existing EquipmentCategory in the same company',
  })
  @IsString()
  @IsNotEmpty()
  categoryId!: string;

  @ApiProperty({ example: 1250.0, description: 'Per meter unit (hour or km)' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  ratePerUnit!: number;

  @ApiProperty({ example: '2026-04-01' })
  @IsISO8601()
  effectiveFrom!: string;

  @ApiPropertyOptional({
    description:
      'Omit for an open-ended ("current") rate, which closes the prior current ' +
      "rate's effectiveTo to the day before this one starts (FR-014)",
  })
  @IsOptional()
  @IsISO8601()
  effectiveTo?: string;
}

export class ListHireRatesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}
