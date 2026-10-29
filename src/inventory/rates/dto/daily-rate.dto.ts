import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** Most rows one save may carry: every daily item × its vendors, with room to spare. */
export const MAX_DAILY_RATE_ROWS = 500;

/** The board for one date (050). */
export class DailyRateBoardQueryDto {
  @ApiPropertyOptional({
    description:
      'YYYY-MM-DD; the rates in force on this day. Defaults to today.',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({ description: 'Cross-company callers: the company' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}

/** The rate in force for one item (and vendor) on one date (050). */
export class EffectiveDailyRateQueryDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  itemId!: string;

  @ApiPropertyOptional({ description: 'The vendor, for their override' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string;

  @ApiProperty({ description: 'YYYY-MM-DD — the document date' })
  @IsDateString()
  date!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}

/** One item's dated history (050). */
export class DailyRateHistoryQueryDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  itemId!: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, inclusive' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, inclusive' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}

export class DailyRateRowDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  itemId!: string;

  @ApiPropertyOptional({
    description:
      'Omit (or null) for the market rate; a vendor for their override.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string | null;

  @ApiProperty({
    nullable: true,
    description:
      "Rupees per unit. Null removes that day's row — a vendor's override goes back to the market rate.",
  })
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rate!: number | null;
}

/** Update today's rates (050): every changed rate on the board, in one save. */
export class SetDailyRatesDto {
  @ApiProperty({ description: 'YYYY-MM-DD; today or earlier' })
  @IsDateString()
  date!: string;

  @ApiProperty({ type: [DailyRateRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_DAILY_RATE_ROWS)
  @ValidateNested({ each: true })
  @Type(() => DailyRateRowDto)
  rates!: DailyRateRowDto[];
}
