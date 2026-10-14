import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
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

/**
 * A non-BOQ item added to a bill to the client (2026-10-14): work the tendered BOQ does not list.
 * The amount is `quantity × rate`, with no tender premium — an extra item is priced by agreement.
 */
export class AddNonBoqItemDto {
  @ApiProperty({ example: 'Providing and fixing km stones (extra item)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;

  @ApiProperty({ example: 'Nos', description: 'Cum, Sqm, Rmt, Nos…' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  unit: string;

  @ApiProperty({
    example: '12',
    description: 'Quantity, or number, billed on this bill.',
  })
  @IsNumberString()
  quantity: string;

  @ApiProperty({
    example: '1450.00',
    description: 'Agreed rate per unit, in rupees.',
  })
  @IsNumberString()
  rate: string;
}

/** Corrects a non-BOQ item — only while no issued bill carries it. Omitted fields are unchanged. */
export class UpdateNonBoqItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  unit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  rate?: string;
}
