import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveTypeCode } from '@prisma/client';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** `YYYY-MM-DD`. A leave date is a calendar date, so the DTO accepts only that
 * shape — an ISO instant would carry a timezone the server would have to guess at
 * and could shift the range by a day. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateLeaveApplicationDto {
  @ApiProperty({ enum: LeaveTypeCode })
  @IsEnum(LeaveTypeCode)
  leaveType: LeaveTypeCode;

  @ApiProperty({ example: '2026-09-14', description: 'Inclusive start date.' })
  @Matches(DATE_ONLY, { message: 'fromDate must be a YYYY-MM-DD date' })
  fromDate: string;

  @ApiProperty({ example: '2026-09-16', description: 'Inclusive end date.' })
  @Matches(DATE_ONLY, { message: 'toDate must be a YYYY-MM-DD date' })
  toDate: string;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class LeaveBalanceQueryDto {
  /** Defaults to the financial year containing today when omitted. */
  @ApiPropertyOptional({ example: '2026-27' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, {
    message: 'financialYear must look like 2026-27',
  })
  financialYear?: string;
}
