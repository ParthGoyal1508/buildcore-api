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
  MaxLength,
  Min,
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
/**
 * The widest geofence a site may declare (036 I24). Nothing stopped 5,000,000 m being typed —
 * a radius that flags nobody anywhere in the country, which is a geofence switched off while
 * looking switched on. Five kilometres covers the largest real site (a highway package's camp
 * and batching plant) with room to spare.
 */
export const GEOFENCE_RADIUS_MAX_METERS = 5000;

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
    maximum: GEOFENCE_RADIUS_MAX_METERS,
    description:
      'Employees punching outside this radius will be flagged. At most 5,000 m (036 I24).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(GEOFENCE_RADIUS_MAX_METERS, {
    message: `geofenceRadiusMeters must be at most ${GEOFENCE_RADIUS_MAX_METERS} (5 km)`,
  })
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
  @MaxLength(100)
  projectId?: string;

  @ApiPropertyOptional({
    description:
      'Postal address, distinct from the geofence centre — the coordinates say ' +
      'where a punch counts, this says where to send a delivery.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
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
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
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
  @Max(2_147_483_647)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  pageSize?: number;

  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}
