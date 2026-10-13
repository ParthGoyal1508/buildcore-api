import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { CreateDwrLineDto, MAX_DWR_LINES } from './create-dwr.dto';

/**
 * One line of an edit: everything a new line carries, plus **which existing line it is**.
 *
 * A separate class rather than an optional field on `CreateDwrLineDto`, so a creation that sends an
 * id is a 400 under `forbidNonWhitelisted` rather than a value quietly dropped. There is nothing an
 * id could mean on a report that does not exist yet.
 */
export class UpdateDwrLineDto extends CreateDwrLineDto {
  /**
   * The stored line this one replaces. Omit for a line being added.
   *
   * **Omitting it on a line that already exists deletes its evidence.** Attachments cascade from
   * the line they are filed against, so a line that is not sent back by id is removed along with
   * every photograph of the work it measured. That is the right answer when a measurement is
   * deleted and the wrong one when a chainage is corrected, and only the caller knows which it
   * meant — which is why this is sent rather than inferred.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  id?: string;
}

/**
 * Editing a report (022 FR-018, US3 AC1).
 *
 * **No `workDate` and no `dprNumber`.** Both are deliberately absent rather than optional. A
 * report is the record of one named day; moving its date would make it the record of a different
 * day while keeping the number people have filed it under, which is not an edit but a forgery of a
 * second report. The remedy is to delete the draft and record the right day.
 *
 * Supplying `lines` **replaces** them. A line sent back with its `id` is kept and edited in place;
 * one that is not sent is removed. See {@link UpdateDwrLineDto.id} for why that distinction had to
 * exist, and `DwrService.update` for what it costs.
 */
export class UpdateDwrDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supervisorEmployeeId?: string;
  // `weather` removed from entry by 028 FR-023, column and history kept. See `create-dwr.dto.ts`.

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) workerCount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) machineryCount?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contractFor?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contractNumber?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  rfiNo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  layer?: string;

  /** The report's lines after this edit. Omit to leave them untouched. */
  @ApiPropertyOptional({ type: [UpdateDwrLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DWR_LINES)
  @ValidateNested({ each: true })
  @Type(() => UpdateDwrLineDto)
  lines?: UpdateDwrLineDto[];
}
