import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExitReason } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Initiating an employee's exit (005 US11, FR-031). */
export class InitiateExitDto {
  @ApiProperty({ example: '2026-10-31' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'lastWorkingDay must be YYYY-MM-DD',
  })
  lastWorkingDay: string;

  @ApiProperty({ enum: ExitReason })
  @IsEnum(ExitReason)
  reason: ExitReason;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

/** Processing the computed settlement into an F&F payroll run (FR-033). */
export class ProcessFnfDto {
  @ApiPropertyOptional({
    description:
      'Period the F&F run is filed under. Defaults to the last working day’s ' +
      'month.',
    example: '2026-10',
  })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be YYYY-MM' })
  period?: string;
}
