import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { CreateDwrLineDto, MAX_DWR_LINES } from './create-dwr.dto';

/**
 * Editing a report (022 FR-018, US3 AC1).
 *
 * **No `workDate` and no `dprNumber`.** Both are deliberately absent rather than optional. A
 * report is the record of one named day; moving its date would make it the record of a different
 * day while keeping the number people have filed it under, which is not an edit but a forgery of a
 * second report. The remedy is to delete the draft and record the right day.
 *
 * Supplying `lines` **replaces** them wholesale. A draft's lines are referenced by nothing — only
 * approval creates references — so diffing them would be machinery with no beneficiary.
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

  /** Replaces every line. Omit to leave them untouched. */
  @ApiPropertyOptional({ type: [CreateDwrLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DWR_LINES)
  @ValidateNested({ each: true })
  @Type(() => CreateDwrLineDto)
  lines?: CreateDwrLineDto[];
}
