import { ApiPropertyOptional } from '@nestjs/swagger';
import { PunchRefusalReason } from '@prisma/client';
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';

/** Filters for the punch refusal log (020 FR-013c). */
export class RefusalsQueryDto {
  @ApiPropertyOptional({
    description:
      'Restrict to one employee — "is this person being refused repeatedly".',
  })
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiPropertyOptional({
    description:
      'Earliest punch time to include, ISO 8601. Filters on when the punch was **taken**, not ' +
      'when it reached the server: a refused offline punch describes a moment that may be days ' +
      'before it arrived, and a log filtered on arrival would file it under the wrong day.',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'Latest punch time to include, ISO 8601.',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    enum: PunchRefusalReason,
    description:
      'One reason. `unlocatable` and `outside_geofence` are separate values on purpose — a rise ' +
      'in the first is usually a phone or a building, a rise in the second is usually a fence.',
  })
  @IsOptional()
  @IsEnum(PunchRefusalReason)
  reason?: PunchRefusalReason;
}
