import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type { MusterFilter } from '../muster-attendance.service';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const FILTERS: MusterFilter[] = [
  'missing_punch_out',
  'flagged',
  'present',
  'absent',
  'on_site',
  'short',
];

export class MusterDailyQueryDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD; today when omitted' })
  @IsOptional()
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional({
    description: 'Every site the caller works when omitted',
  })
  @IsOptional()
  @IsString()
  siteId?: string;

  @ApiPropertyOptional({ enum: FILTERS })
  @IsOptional()
  @IsIn(FILTERS)
  filter?: MusterFilter;
}

export class MusterMonthlyQueryDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiProperty({ minimum: 1, maximum: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  siteId?: string;
}

export class PunchCorrectionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workerId!: string;

  @ApiProperty({ description: 'The day being corrected, YYYY-MM-DD' })
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @ApiPropertyOptional({
    description: 'HH:mm, 24-hour, in the company time zone',
  })
  @IsOptional()
  @Matches(TIME, { message: 'punchIn must be HH:mm' })
  punchIn?: string;

  @ApiPropertyOptional({
    description: 'HH:mm, 24-hour, in the company time zone',
  })
  @IsOptional()
  @Matches(TIME, { message: 'punchOut must be HH:mm' })
  punchOut?: string;

  @ApiProperty({
    description: 'Why the time is being added or changed — kept in the history',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class PunchHistoryQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workerId!: string;

  @ApiProperty()
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date!: string;
}

export class LabourDayRulesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;
}

export class LabourDayRulesDto {
  @ApiProperty({
    example: 8,
    description: 'At least this many hours is a full day',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  fullDayHours!: number;

  @ApiProperty({
    example: 4,
    description: 'At least this many is a half day; fewer is short',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  halfDayHours!: number;

  @ApiProperty({ example: 8, description: 'Hours beyond this are overtime' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  standardHours!: number;
}

export class SitePhotoDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty({
    description: 'Base64-encoded photo (data-URL prefix optional).',
  })
  @IsString()
  @IsNotEmpty()
  photo!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  longitude?: number;
}

export class SitePhotoQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
