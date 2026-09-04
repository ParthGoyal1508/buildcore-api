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
  Min,
} from 'class-validator';

export class CreateFuelEntryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  equipmentId!: string;

  @ApiProperty({ example: '2026-09-04' })
  @IsISO8601()
  date!: string;

  @ApiProperty({ description: 'Litres' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  quantity!: number;

  @ApiProperty({ description: 'Rupees per litre' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rate!: number;

  @ApiPropertyOptional({
    description: 'The filling station or diesel supplier',
  })
  @IsOptional()
  @IsString()
  vendorId?: string;
}

export class ListFuelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
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
  varianceOnly?: string;

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

export class FuelSummaryDto {
  @ApiProperty({ example: '2026-09', description: 'YYYY-MM' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}
