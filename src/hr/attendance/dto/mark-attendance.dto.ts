import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttendanceStatusOverride } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The admin Mark/Edit Attendance action (005 US3).
 *
 * Times are `HH:mm` on the given date rather than full instants: an admin marking
 * attendance is stating a calendar fact about a working day, and accepting an
 * instant would invite a client in another timezone to shift the day.
 */
export class MarkAttendanceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({ example: '2026-09-02' })
  @Matches(DATE_ONLY, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiPropertyOptional({ example: '09:05' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'inTime must be HH:mm' })
  inTime?: string;

  @ApiPropertyOptional({ example: '18:10' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'outTime must be HH:mm' })
  outTime?: string;

  @ApiPropertyOptional({
    enum: AttendanceStatusOverride,
    description:
      'Forces the day status instead of deriving it from the punches — used when ' +
      'marking a day present or absent against what the punches imply.',
  })
  @IsOptional()
  @IsEnum(AttendanceStatusOverride)
  statusOverride?: AttendanceStatusOverride;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

/** Date + site scoping for the admin daily attendance view. */
export class DailyAttendanceQueryDto {
  @ApiProperty({ example: '2026-09-02' })
  @Matches(DATE_ONLY, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  siteId?: string;
}

/** Filters for the Modifications audit view. */
export class ModificationsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  pageSize?: number;
}
