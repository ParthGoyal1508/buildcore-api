import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { SiteStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
} from 'class-validator';

/**
 * A new site (spec US2).
 *
 * The geofence fields are **required**, unlike data-model.md, which lists them as
 * optional. They are `NOT NULL` columns created by 003 and read on every punch by
 * `SitesService.getGeofence()`; this feature's migration is additive and does not
 * widen them. Accepting a site without coordinates would therefore either fail at
 * the database or force a null check into the attendance hot path — so the DTO
 * states the requirement the schema already enforces.
 */
export class CreateSiteDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    description:
      'Geofence centre latitude. Punches outside the radius are flagged.',
  })
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ description: 'Geofence centre longitude.' })
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @ApiProperty({
    minimum: 1,
    description: 'Employees punching outside this radius will be flagged.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  geofenceRadiusMeters!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 6,
    description: 'Day treated as Weekly Off, 0 = Sunday.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  weeklyOffDay!: number;

  @ApiPropertyOptional({ description: 'The project this site belongs to.' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    description:
      'Postal address, distinct from the geofence centre — the coordinates say ' +
      'where a punch counts, this says where to send a delivery.',
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ enum: SiteStatus, default: SiteStatus.active })
  @IsOptional()
  @IsEnum(SiteStatus)
  status?: SiteStatus;
}

/** Every create field, all optional. */
export class UpdateSiteDto extends PartialType(CreateSiteDto) {}

/**
 * Query parameters for the site list. A DTO class rather than loose `@Query()`
 * parameters — see `ListClientsDto` for why.
 */
export class ListSitesDto {
  @ApiPropertyOptional({ description: 'Matches the site name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    enum: SiteStatus,
    description: 'Omit to see both active and inactive',
  })
  @IsOptional()
  @IsEnum(SiteStatus)
  status?: SiteStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsOptional()
  @IsString()
  companyId?: string;
}
