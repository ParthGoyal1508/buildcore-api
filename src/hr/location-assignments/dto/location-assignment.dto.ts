import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Assigning the location an employee's punches validate against (020 FR-011, FR-014).
 *
 * Every write **appends**. There is no update DTO and no id to update, deliberately: a transfer six
 * months ago has to stay explicable, and a mutable current value cannot answer that.
 */
export class AssignLocationDto {
  @ApiPropertyOptional({
    description:
      'The site whose fence applies. Required unless `isMobile` — an assignment naming no ' +
      'site and claiming no exemption validates nothing, and the database rejects it.',
  })
  // Required precisely when there is no exemption — the same rule the check constraint enforces,
  // stated here too so the caller gets a 400 naming the field rather than a 500 from Postgres.
  @ValidateIf((dto: AssignLocationDto) => !dto.isMobile)
  @IsString()
  @MaxLength(200)
  siteId?: string;

  @ApiPropertyOptional({
    description:
      'Exempt from **location** validation only (FR-014). A mobile employee is refused for a ' +
      'face mismatch exactly as anyone else is: mobility says where a person legitimately ' +
      'works, the face check says who is holding the phone.',
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
