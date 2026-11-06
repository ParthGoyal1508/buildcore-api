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
  @MaxLength(100)
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
  @ApiPropertyOptional({
    description:
      'The site the punches are recorded against (058). One of the sites the employee is ' +
      'assigned to that day, or any active site of the company for a mobile employee; 400 ' +
      '`SITE_NOT_ASSIGNED` otherwise. Omitted, the employee\u2019s only site is used when they ' +
      'have exactly one, and none is recorded when they have several.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siteId?: string;
}

/** Date + site scoping for the admin daily attendance view. */
export class DailyAttendanceQueryDto {
  @ApiProperty({ example: '2026-09-02' })
  @Matches(DATE_ONLY, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiPropertyOptional({
    description:
      'Employees posted at this site (their home site), whether or not they punched.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siteId?: string;

  @ApiPropertyOptional({
    description:
      'Only employees with a punch in or out **at** this site that day (058) — "who punched at ' +
      'site X on day D", whatever their home site.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  punchSiteId?: string;
}

/** Filters for the Modifications audit view. */
export class ModificationsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  employeeId?: string;

  /**
   * Narrow the audit to changes made by one person (016 FR-012d).
   *
   * Composes with `employeeId` and the date range rather than replacing them, so
   * "what did this person change to this employee in September" is one question.
   */
  @ApiPropertyOptional({
    description: 'Only changes made by this user.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  actorUserId?: string;

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
