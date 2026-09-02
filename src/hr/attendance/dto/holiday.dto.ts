import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HolidayType } from '@prisma/client';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Declaring a company holiday (005 US3, research.md §6).
 *
 * Supersedes the bare `Site.holidays` date array, which could not express a name, a
 * type, or "national holiday, applies everywhere" without repeating the date on
 * every site.
 */
export class CreateHolidayDto {
  @ApiProperty({ example: 'Independence Day' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: '2026-08-15' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiPropertyOptional({ enum: HolidayType, default: HolidayType.company })
  @IsOptional()
  @IsEnum(HolidayType)
  type?: HolidayType;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  appliesToAllSites?: boolean;

  @ApiPropertyOptional({
    description:
      'Required when appliesToAllSites is false — a holiday that applies to no ' +
      'site would silently do nothing.',
    type: [String],
  })
  @ValidateIf((o: CreateHolidayDto) => o.appliesToAllSites === false)
  @IsArray()
  @ArrayNotEmpty({
    message: 'siteIds is required when appliesToAllSites is false',
  })
  @IsString({ each: true })
  siteIds?: string[];
}

/** Filters for listing the holiday calendar. */
export class ListHolidaysQueryDto {
  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  siteId?: string;
}
