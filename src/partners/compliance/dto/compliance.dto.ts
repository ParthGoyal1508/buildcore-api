import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/** `YYYY-MM`, with the month constrained to 01–12 so `2025-13` is rejected at the
 * boundary rather than becoming a row nothing will ever match. */
export const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

export class CreateComplianceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  contractorProfileId: string;

  @ApiProperty({ example: '2026-08' })
  @Matches(MONTH_REGEX, { message: 'month must be in YYYY-MM format' })
  month: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  pfChallanNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  pfAmount?: number;

  @ApiPropertyOptional({ description: 'ISO date' })
  @IsOptional()
  @IsDateString()
  pfDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  esicChallanNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  esicAmount?: number;

  @ApiPropertyOptional({ description: 'ISO date' })
  @IsOptional()
  @IsDateString()
  esicDate?: string;
}

/** `month` and `contractorProfileId` are absent: together they identify the row, and
 * changing either would move a filing to a different month or contractor rather than
 * correct it. */
export class UpdateComplianceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  pfChallanNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  pfAmount?: number;

  @ApiPropertyOptional({ description: 'ISO date' })
  @IsOptional()
  @IsDateString()
  pfDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  esicChallanNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  esicAmount?: number;

  @ApiPropertyOptional({ description: 'ISO date' })
  @IsOptional()
  @IsDateString()
  esicDate?: string;
}

export class ListComplianceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contractorProfileId?: string;

  @ApiPropertyOptional({ example: '2026-08' })
  @IsOptional()
  @Matches(MONTH_REGEX, { message: 'month must be in YYYY-MM format' })
  month?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}
