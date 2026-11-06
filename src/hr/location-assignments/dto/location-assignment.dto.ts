import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Assigning the locations an employee's punches validate against (020 FR-011, FR-014; 058).
 *
 * Every write **appends**. There is no update DTO and no id to update, deliberately: a transfer six
 * months ago has to stay explicable, and a mutable current value cannot answer that.
 *
 * "Mobile, or at least one site or project" is checked by the service, which answers with
 * `ASSIGNMENT_EMPTY` or `ASSIGNMENT_MOBILE_WITH_TARGETS`.
 */
export class AssignLocationDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Sites whose fences apply (058). A punch inside any of them is accepted and recorded ' +
      'against the nearest.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  siteIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Projects (058): every **active** site of each, resolved at the moment of each punch — a ' +
      'site added to the project later is covered without a new assignment.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  projectIds?: string[];

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'The single site of an assignment before 058. Still accepted for one release, read as ' +
      '`siteIds: [siteId]`, so a web build that predates 058 keeps working.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  siteId?: string;

  @ApiPropertyOptional({
    description:
      'Exempt from **location** validation only (FR-014). A mobile employee is refused for a ' +
      'face mismatch exactly as anyone else is: mobility says where a person legitimately ' +
      'works, the face check says who is holding the phone. Excludes sites and projects.',
  })
  @IsOptional()
  @IsBoolean()
  isMobile?: boolean;

  @ApiProperty({
    description:
      'The day from which this assignment decides, `YYYY-MM-DD`. Resolution keys on the ' +
      "punch's own day, so an offline punch validates against what was in force when it was taken.",
    example: '2026-10-01',
  })
  @IsISO8601()
  effectiveFrom: string;

  @ApiPropertyOptional({
    description:
      'Why. A mobile exemption without one is unreviewable — somebody reading it a year later ' +
      'cannot tell whether it was considered or merely convenient.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** The body as the service reads it: the deprecated single `siteId` folded into `siteIds`. */
export function assignInputFrom(dto: AssignLocationDto) {
  return {
    siteIds: [...(dto.siteIds ?? []), ...(dto.siteId ? [dto.siteId] : [])],
    projectIds: dto.projectIds ?? [],
    isMobile: dto.isMobile,
    effectiveFrom: dto.effectiveFrom,
    reason: dto.reason,
  };
}
