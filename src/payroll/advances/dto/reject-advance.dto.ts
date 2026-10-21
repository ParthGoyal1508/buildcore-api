import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Rejecting a loan or advance on its approval chain (2026-10-20). The employee reads the reason. */
export class RejectAdvanceDto {
  @ApiProperty({ description: 'Why it was rejected.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}
