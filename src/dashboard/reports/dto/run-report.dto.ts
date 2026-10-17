import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsObject, IsOptional, Matches } from 'class-validator';

/** 036 E2: a calendar date, the only shape a report range takes. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Body for `POST /reports/:type/run` — a date range plus per-type filters. */
export class RunReportDto {
  @ApiPropertyOptional({ description: 'Range start, YYYY-MM-DD.' })
  // An empty box arrives as '' — the same as no date, not a malformed one.
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'From must be a date (YYYY-MM-DD)' })
  fromDate?: string;

  @ApiPropertyOptional({ description: 'Range end, YYYY-MM-DD.' })
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'To must be a date (YYYY-MM-DD)' })
  toDate?: string;

  @ApiPropertyOptional({
    description:
      'Per-report-type filter values, keyed by the type’s FilterSpec keys.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  filters?: Record<string, string>;
}
