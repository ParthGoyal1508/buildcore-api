import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for `POST /reports/:type/run` — a date range plus per-type filters. */
export class RunReportDto {
  @ApiPropertyOptional({ description: 'Range start, YYYY-MM-DD.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fromDate?: string;

  @ApiPropertyOptional({ description: 'Range end, YYYY-MM-DD.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
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
