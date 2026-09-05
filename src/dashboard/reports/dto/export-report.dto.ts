import { ApiProperty } from '@nestjs/swagger';
import { ExportFormat } from '@prisma/client';
import { IsEnum } from 'class-validator';

import { RunReportDto } from './run-report.dto';

/** Body for `POST /reports/:type/export` — a report run plus the output format. */
export class ExportReportDto extends RunReportDto {
  @ApiProperty({ enum: ExportFormat })
  @IsEnum(ExportFormat)
  format!: ExportFormat;
}
