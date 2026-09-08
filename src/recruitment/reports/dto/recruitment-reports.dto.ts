import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The reporting period every period-scoped recruitment report takes.
 *
 * A DTO rather than the individual `@Query('from')` parameters this controller used
 * to declare. With separate parameters the global `ValidationPipe` has no class to
 * validate against, so nothing was checked at all: omitting `from` handed `undefined`
 * to the service, which sliced it and returned a 500. A missing date is a request
 * problem and must read as one.
 *
 * `Matches(DATE_ONLY)` rather than `IsDateString`, matching `MarkAttendanceDto`.
 * `IsDateString` would accept a full instant with an offset, which the service then
 * truncates to its first ten characters — quietly moving a period boundary by a day
 * for any caller in a zone behind UTC. A report boundary is a calendar date, so the
 * contract should only accept one.
 */
export class ReportPeriodQueryDto {
  @ApiProperty({ example: '2026-04-01' })
  @Matches(DATE_ONLY, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @ApiProperty({ example: '2026-09-30' })
  @Matches(DATE_ONLY, { message: 'to must be YYYY-MM-DD' })
  to!: string;
}

export class NewJoiningsQueryDto extends ReportPeriodQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class ResignationsQueryDto extends ReportPeriodQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  departmentId?: string;

  /**
   * Average headcount for the period, the denominator of the attrition rate.
   *
   * Validated as a positive integer because the previous `Number(headcount)` turned
   * any non-numeric value into `NaN` and carried it into the division, reporting an
   * attrition rate of `null` that is indistinguishable from "no headcount supplied".
   */
  @ApiPropertyOptional({ example: 240 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  headcount?: number;
}

export class FunnelQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  requisitionId?: string;
}
