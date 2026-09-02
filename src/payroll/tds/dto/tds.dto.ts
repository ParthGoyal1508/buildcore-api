import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaxRegime } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const FY = /^\d{4}-\d{2}$/;

export class TaxSlabBandDto {
  @ApiProperty({ description: 'Inclusive lower bound.' })
  @IsNumber()
  @Min(0)
  lowerBound: number;

  @ApiPropertyOptional({
    description: 'Exclusive upper bound. Omit for the final open-ended band.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  upperBound?: number | null;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(100)
  ratePercent: number;
}

export class SetTaxSlabsDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(FY, { message: 'financialYear must be YYYY-YY' })
  financialYear: string;

  @ApiProperty({ enum: TaxRegime })
  @IsEnum(TaxRegime)
  regime: TaxRegime;

  @ApiProperty({ type: [TaxSlabBandDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => TaxSlabBandDto)
  bands: TaxSlabBandDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}

export class DeclarationLineDto {
  @ApiProperty({ example: '80C' })
  @IsString()
  @IsNotEmpty()
  sectionCode: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  declaredAmount: number;

  @ApiPropertyOptional({ description: 'Object-storage reference for the proof.' })
  @IsOptional()
  @IsString()
  proofRef?: string;
}

export class DeclareTaxDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(FY, { message: 'financialYear must be YYYY-YY' })
  financialYear: string;

  @ApiProperty({ enum: TaxRegime })
  @IsEnum(TaxRegime)
  regime: TaxRegime;

  @ApiProperty({ type: [DeclarationLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeclarationLineDto)
  lines: DeclarationLineDto[];
}

export class QuarterlyQueryDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(FY, { message: 'financialYear must be YYYY-YY' })
  financialYear: string;

  @ApiProperty({ minimum: 1, maximum: 4 })
  @IsInt()
  @Min(1)
  @Max(4)
  @Type(() => Number)
  quarter: 1 | 2 | 3 | 4;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}
