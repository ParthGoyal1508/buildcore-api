import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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
  @MaxLength(2_000)
  module?: string;

  @ApiPropertyOptional({ enum: ACTIVITY_TIME_RANGES })
  @IsOptional()
  @IsIn(ACTIVITY_TIME_RANGES)
  timeRange?: ActivityTimeRange;

  /**
   * 036 E3: a custom range, business-timezone days, inclusive. Takes precedence over `timeRange`
   * when either end is given.
   */
  @ApiPropertyOptional({ description: 'From this day (YYYY-MM-DD), inclusive.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  @ApiPropertyOptional({ description: 'To this day (YYYY-MM-DD), inclusive.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;

  @ApiPropertyOptional({ description: 'Only actions by this account.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  userId?: string;

  @ApiPropertyOptional({
    description:
      'Search: the name or email of who acted, or a record id typed in full.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  page?: number;
}

/** Query for `GET /activity-log/users` (036 E3). */
export class ActivityLogUsersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number;
}
