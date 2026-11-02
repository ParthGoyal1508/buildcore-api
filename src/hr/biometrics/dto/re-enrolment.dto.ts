import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReEnrolmentRequestStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** An employee asking for their face template to be replaced (FR-013). */
export class RequestReEnrolmentDto {
  @ApiProperty({
    maxLength: 500,
    description:
      'Why re-enrolment is needed — the only thing the approver has to judge on.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

/**
 * The approver's verdict on a re-enrolment request (FR-014).
 *
 * Same shape and same reasoning as the leave decision DTO: only the two terminal
 * decisions are accepted, so an approver cannot push a request back to pending or
 * mark it completed on the employee's behalf.
 */
export class ReEnrolmentDecisionDto {
  @ApiProperty({ enum: ['approved', 'rejected'] })
  @IsIn(['approved', 'rejected'])
  decision: 'approved' | 'rejected';

  @ApiPropertyOptional({ maxLength: 500 })
  @ValidateIf((dto: ReEnrolmentDecisionDto) => dto.decision === 'rejected')
  @IsString({ message: 'remarks are required when rejecting a request' })
  @MaxLength(500)
  remarks?: string;
}

export class ReEnrolmentQueryDto {
  @ApiPropertyOptional({ enum: ReEnrolmentRequestStatus })
  @IsOptional()
  @IsIn(Object.values(ReEnrolmentRequestStatus))
  status?: ReEnrolmentRequestStatus;
}

/**
 * The fresh capture that consumes an approved unlock (FR-016).
 *
 * `consentMethod` is deliberately absent: consent was recorded at the original
 * enrolment and is not being re-collected here, only re-acknowledged. Re-enrolment
 * replaces a template; it is not a new consent event.
 */
export class CompleteReEnrolmentDto {
  @ApiProperty({
    description:
      'The liveness challenge the capture followed (057, flow `staff-enrolment`); the photos are ' +
      'the multipart `frames`.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  challengeId: string;

  @ApiProperty({ description: 'Must be exactly true.' })
  @Transform(({ value }) => value === true || value === 'true')
  @Equals(true, {
    message: 'consentAcknowledged must be true to re-enrol biometric data.',
  })
  consentAcknowledged: boolean;
}
