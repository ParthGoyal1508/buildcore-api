import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * The monthly wage roll-up's query (018 T056, FR-010a).
 *
 * The month is **bounded here rather than checked in the service** (Principle II). A month of `13`
 * or a year of `20266` would otherwise resolve to a date range containing no payment sheet and come
 * back as a well-formed, empty, entirely believable month — which is worse than a refusal, because
 * nothing on the response says the question was nonsense.
 *
 * `year` and `month` as separate integers rather than the P&L's `YYYY-MM` string: a string has to be
 * parsed before it can be bounded, and the parse is where `2026-9`, `2026-09-01` and `26-09` each
 * become a different silent answer. The response carries `period` in `YYYY-MM` so the two surfaces
 * still join on one key.
 */
export class MonthlyWageRollupDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  /**
   * 2000 is before this product existed and 2100 is long after anybody reading this is in post;
   * the bound exists to catch a transposed or unparsed field, not to express a business rule.
   */
  @ApiProperty({ example: 2026, minimum: 2000, maximum: 2100 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiProperty({ example: 9, minimum: 1, maximum: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  /** Honoured only for a cross-company caller; ignored for everybody else (`companyScope`). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}
