import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * The query every P&L read takes, as a DTO rather than bare `@Query` parameters.
 *
 * All three routes answered **500** when a required parameter was absent: `period`
 * reached `periodRange`, which does `period.split('-')`, and `projectIds` reached
 * `projectIds.split(',')`. A `TypeError` surfaces as "Internal server error", so a
 * caller that forgot a parameter was told the server was broken — and the log said the
 * same, which is how a client bug becomes an afternoon reading server traces.
 *
 * Measured before this existed: `GET /projects/pnl`, `/projects/pnl/export` and
 * `/projects/pnl/group` each answered 500 with no query string; `/projects/pnl/drill-down`
 * answered 400, because its `figure` is checked in the service.
 *
 * The same fault, and the same fix, as `list-leave-applications.dto.ts` and
 * `fuel-exception.dto.ts` — a DTO is a metatype the global `ValidationPipe` can refuse,
 * and these are the parameters a refusal has to name.
 *
 * `period` is matched here as well as parsed in the service. Not duplication for its own
 * sake: `periodRange` throws `NotFoundException` for a malformed month, so without this a
 * typo answered **404** — "that project does not exist" for a request about a project
 * that does.
 */
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export class PnlQueryDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  projectId!: string;

  @ApiProperty({ example: '2026-10' })
  @Matches(PERIOD, { message: 'period must be YYYY-MM' })
  period!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}

/** `PnlQueryDto` plus the export's format. */
export class PnlExportQueryDto extends PnlQueryDto {
  @ApiPropertyOptional({ enum: ['pdf', 'excel'], default: 'pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  format?: string;
}

/** The group view's query: several projects, one month. */
export class PnlGroupQueryDto {
  @ApiProperty({
    description: 'Comma-separated project ids.',
    example: 'cku1…,cku2…',
  })
  @IsString()
  @MinLength(1)
  // Room for 200 ids (25-character cuids plus commas). 036 B11 capped this at 100 characters,
  // which is three ids, and the group P&L refused every company with a fourth project (Wave 5).
  @MaxLength(5400)
  projectIds!: string;

  @ApiProperty({ example: '2026-10' })
  @Matches(PERIOD, { message: 'period must be YYYY-MM' })
  period!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}
