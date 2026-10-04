import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Setting one line's claimed quantity (023 FR-004, FR-006, FR-004a).
 *
 * `IsNumberString` rather than `IsNumber`, matching the BOQ DTOs in this repository: quantities are
 * `Decimal(18,3)` and arrive as strings, because a decimal that has been through a double is a
 * decimal that has been rounded by somebody other than us. 022's e2e suite had all twenty-four of
 * its tests failing from a single `beforeAll` line that sent numbers instead.
 */
export class SetBillLineClaimDto {
  @ApiProperty({
    example: '0.700',
    description:
      'What is being billed for this line, in the line’s own unit. Defaults to the approved ' +
      'measurement for the period; this field is for the reviewer’s judgement on top of it.',
  })
  @IsNumberString()
  claimedQty: string;

  @ApiPropertyOptional({
    example:
      '30% deduction — shoulder slope, supervisor labour, staff not available & ROW not cleaned',
    description:
      'Why the claim differs from the proposal. **Required** for a reduction and for an ' +
      'over-claim, and **cleared** when a later edit returns the claim to its proposal: a reason ' +
      'sitting beside a zero variance argues on the measurement sheet for a deduction the bill ' +
      'does not make. Reproduced verbatim — it is the argument the document exists to settle.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
