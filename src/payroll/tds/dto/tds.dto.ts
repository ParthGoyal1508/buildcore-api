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
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const FY = /^\d{4}-\d{2}$/;

export class TaxSlabBandDto {
  @ApiProperty({ description: 'Inclusive lower bound.' })
  @IsNumber()
  @Min(0)
  @Max(999_999_999_999.99)
  lowerBound: number;

  @ApiPropertyOptional({
    description: 'Exclusive upper bound. Omit for the final open-ended band.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999_999_999_999.99)
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
  @MaxLength(100)
  companyId?: string;
}

export class DeclarationLineDto {
  @ApiProperty({ example: '80C' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sectionCode: string;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(999_999_999_999.99)
  declaredAmount: number;

  @ApiPropertyOptional({
    description: 'Object-storage reference for the proof.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
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
  @MaxLength(100)
  companyId?: string;
}

/**
 * Which financial year's slab set, under which regime.
 *
 * A DTO rather than three bare `@Query(...)` parameters, because one of them —
 * `regime: TaxRegime` — made the global `ValidationPipe` validate against a Prisma enum
 * object as though it were a class. That returns a 500 rather than a 400 for a regime
 * that is not a regime, and a 500 if the parameter is omitted at all. The same fault as
 * `list-leave-applications.dto.ts` documents; this was the last site carrying it.
 */
export class SlabsQueryDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(FY, { message: 'financialYear must be YYYY-YY' })
  financialYear: string;

  @ApiProperty({ enum: TaxRegime })
  @IsEnum(TaxRegime)
  regime: TaxRegime;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}

/**
 * A financial year, for the two per-employee reads that take one.
 *
 * `form-16/:employeeId` answered **500** with the parameter absent — the year reached
 * the data builder and was dereferenced — and `declarations/:employeeId` answered
 * **200**, which is worse: a declaration "for a financial year" returned something for
 * an unspecified year rather than refusing the question.
 *
 * Measured before this existed. Same family as `SlabsQueryDto` above and
 * `list-leave-applications.dto.ts`: a bare `@Query` the handler assumes is present is a
 * parameter the global `ValidationPipe` has nothing to refuse.
 */
export class FinancialYearQueryDto {
  @ApiProperty({ example: '2026-27' })
  @Matches(FY, { message: 'financialYear must be YYYY-YY' })
  financialYear!: string;
}
