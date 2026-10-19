import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Query for `GET /group/statutory-calendar`. */
export class StatutoryCalendarQueryDto {
  @ApiPropertyOptional({ description: 'Financial year, e.g. 2026-27.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  financialYear?: string;
}
