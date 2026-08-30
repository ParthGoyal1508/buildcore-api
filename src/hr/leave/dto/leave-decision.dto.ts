import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveApplicationStatus } from '@prisma/client';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * An admin's verdict on a leave application (FR-022a).
 *
 * `IsIn` over the two terminal decisions rather than `IsEnum(LeaveApplicationStatus)`:
 * that enum also holds `pending` and `cancelled`, neither of which is a decision an
 * approver can submit — validating against the whole enum would let an admin push an
 * application back to unreviewed, or cancel it on the employee's behalf.
 */
export class LeaveDecisionDto {
  @ApiProperty({ enum: ['approved', 'rejected'] })
  @IsIn(['approved', 'rejected'])
  decision: 'approved' | 'rejected';

  /** Mandatory on rejection: an employee told only "no" has nothing to act on. */
  @ApiPropertyOptional({ maxLength: 500 })
  @ValidateIf((dto: LeaveDecisionDto) => dto.decision === 'rejected')
  @IsString({ message: 'remarks are required when rejecting an application' })
  @MaxLength(500)
  remarks?: string;
}

export class LeaveApplicationQueryDto {
  @ApiPropertyOptional({ enum: LeaveApplicationStatus })
  @IsOptional()
  @IsIn(Object.values(LeaveApplicationStatus))
  status?: LeaveApplicationStatus;
}
