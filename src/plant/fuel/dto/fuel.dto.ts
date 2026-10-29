import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateFuelEntryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  equipmentId!: string;

  @ApiProperty({ example: '2026-09-04' })
  @IsISO8601()
  date!: string;

  /** More than zero (036 K10): a 0-litre "fill" is a mistake, and it divides the rate by zero. */
  @ApiProperty({ description: 'Litres, more than zero' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001, { message: 'quantity must be more than zero litres' })
  @Max(999_999_999_999_999)
  quantity!: number;

  @ApiPropertyOptional({
    description: 'Rupees per litre. Give this or `amount`.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  rate?: number;

  @ApiPropertyOptional({
    description:
      'The rupees paid — the log book\'s "Diesel Advance" (2026-10-15). When given it is ' +
      'stored as paid, and the rate is derived from it.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  amount?: number;

  @ApiPropertyOptional({ description: 'The fuel card it was drawn on' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  cardNo?: string;

  @ApiPropertyOptional({
    description: 'The filling station or diesel supplier',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string;

  @ApiPropertyOptional({
    description:
      'Where the fuel was drawn. Omitted, it is taken from where the machine is ' +
      'currently deployed — which is right at the moment of entry and wrong forever ' +
      'after, which is why it is stored rather than re-derived on read.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siteId?: string;
}

export class ListFuelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  equipmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @ApiPropertyOptional({
    description: 'Only entries whose variance was flagged',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  varianceOnly?: string;

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

export class FuelSummaryDto {
  @ApiProperty({ example: '2026-09', description: 'YYYY-MM' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}

/** 050: the diesel rate a fuel entry on this date is offered. */
export class FuelRateQueryDto {
  @ApiProperty({ description: 'YYYY-MM-DD — the fuel entry date' })
  @IsISO8601()
  date!: string;

  @ApiPropertyOptional({ description: 'The pump, for its own override' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string;

  @ApiPropertyOptional({
    description: "The machine — its company's fuel is the one offered",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  equipmentId?: string;
}
