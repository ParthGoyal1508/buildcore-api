import { ApiPropertyOptional } from '@nestjs/swagger';
import { DwrStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Default and maximum page sizes. Config rather than literals at the call site (Principle III). */
export const DWR_PAGE_SIZE_DEFAULT = 25;
export const DWR_PAGE_SIZE_MAX = 200;

/** Listing a project's reports (022 FR-026). */
export class ListDwrDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;

  /** Inclusive, on **work date** — the day described, not the day recorded. */
  @ApiPropertyOptional({ example: '2025-12-21' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-01-20' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: DwrStatus })
  @IsOptional()
  @IsEnum(DwrStatus)
  status?: DwrStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    default: DWR_PAGE_SIZE_DEFAULT,
    maximum: DWR_PAGE_SIZE_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DWR_PAGE_SIZE_MAX)
  pageSize?: number;
}

/**
 * The range feature 023 asks a bill's figures for (022 FR-034 to FR-038).
 *
 * Both bounds required and both inclusive. An open-ended range would make "approved before the
 * period" meaningless, and the figure 023 defaults a claimed quantity from must be reproducible —
 * two callers asking for the same bill period have to get the same numbers.
 */
export class DwrPeriodDto {
  @ApiPropertyOptional({ example: '2025-12-21' })
  @IsDateString()
  from!: string;

  @ApiPropertyOptional({ example: '2026-01-20' })
  @IsDateString()
  to!: string;
}
