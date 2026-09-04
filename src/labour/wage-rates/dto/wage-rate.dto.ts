import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

export class ListWageRatesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  skillCategoryId?: string;

  @ApiPropertyOptional({
    example: '2026-03-15',
    description: 'Return only rates in force on this date',
  })
  @IsOptional()
  @IsDateString()
  asOf?: string;
}

export class CreateWageRateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  skillCategoryId!: string;

  @ApiProperty({ example: 800 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  dailyRate!: number;

  @ApiProperty({ example: '2026-01-01' })
  @IsDateString()
  effectiveFrom!: string;
}

export class UpdateWageRateDto {
  @ApiProperty({ example: 850 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  dailyRate!: number;
}
