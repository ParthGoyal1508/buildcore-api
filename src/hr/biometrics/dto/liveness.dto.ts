import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** The four captures that need a live face (057). */
export const LIVENESS_FLOWS = [
  'staff-punch',
  'labour-punch',
  'staff-enrolment',
  'labour-enrolment',
] as const;
export type LivenessFlow = (typeof LIVENESS_FLOWS)[number];

export class IssueLivenessChallengeDto {
  @ApiProperty({ enum: LIVENESS_FLOWS })
  @IsIn(LIVENESS_FLOWS)
  flow!: LivenessFlow;

  @ApiPropertyOptional({
    description:
      'The labour the capture is for — required for `labour-punch`, so a challenge issued for one ' +
      'labour cannot be spent on another.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  workerId?: string;
}
