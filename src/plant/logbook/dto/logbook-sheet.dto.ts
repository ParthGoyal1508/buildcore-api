import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** One day entered on the log book and diesel sheet (2026-10-15). */
export class LogbookSheetRowDto {
  @ApiProperty({ example: '2026-08-01' })
  @IsISO8601()
  date!: string;

  @ApiPropertyOptional({ description: 'Starting reading' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  openingReading?: number;

  @ApiPropertyOptional({ description: 'Closing reading' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  closingReading?: number;

  @ApiPropertyOptional({ description: 'Fuel card number' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  cardNo?: string;

  @ApiPropertyOptional({ description: 'Diesel advance, in rupees' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  dieselAmount?: number;

  @ApiPropertyOptional({ description: 'Diesel quantity, in litres' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  dieselQuantity?: number;

  @ApiPropertyOptional({
    description:
      "036. Why the starting reading differs from the previous day's closing one; required " +
      'when it does.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readingGapReason?: string;
}

export class SaveLogbookSheetDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  equipmentId!: string;

  @ApiProperty({ example: '2026-08' })
  @Matches(/^\d{4}-\d{2}$/)
  month!: string;

  @ApiProperty({ type: [LogbookSheetRowDto] })
  @IsArray()
  @ArrayMaxSize(31)
  @ValidateNested({ each: true })
  @Type(() => LogbookSheetRowDto)
  rows!: LogbookSheetRowDto[];
}
