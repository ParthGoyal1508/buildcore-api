import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
} from 'class-validator';

/** A daily wage above this is a typing slip (an extra zero), not a rate. */
const MAX_DAILY_RATE = 100_000;

export class ListSiteWageRatesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  siteId?: string;
}

export class CreateSiteWageRateDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty({ example: '2026-11-01' })
  @IsDateString()
  effectiveFrom!: string;

  @ApiPropertyOptional({ description: 'Daily rate for male labour' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_DAILY_RATE)
  maleRate?: number;

  @ApiPropertyOptional({ description: 'Daily rate for female labour' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_DAILY_RATE)
  femaleRate?: number;
}

export class UpdateSiteWageRateDto {
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_DAILY_RATE)
  dailyRate!: number;
}
