import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

/** The time windows the Activity Log feed can be narrowed to. */
export const ACTIVITY_TIME_RANGES = ['today', '7d', '30d', '90d'] as const;
export type ActivityTimeRange = (typeof ACTIVITY_TIME_RANGES)[number];

/** Query for `GET /activity-log` and `GET /activity-log/export`. */
export class ActivityLogQueryDto {
  @ApiPropertyOptional({
    description:
      'Module filter bucket (hr, settings, payroll, machinery, projects, ' +
      'inventory, partners, recruitment, labour). Omit for all.',
  })
  @IsOptional()
  @IsString()
  module?: string;

  @ApiPropertyOptional({ enum: ACTIVITY_TIME_RANGES })
  @IsOptional()
  @IsIn(ACTIVITY_TIME_RANGES)
  timeRange?: ActivityTimeRange;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
