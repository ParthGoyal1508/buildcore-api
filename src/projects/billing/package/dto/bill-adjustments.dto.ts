import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumberString, IsOptional } from 'class-validator';

/**
 * The month's entered recoveries, deductions and withholdings (025 FR-044).
 *
 * ## Why this did not exist
 *
 * Every one of these columns was read by the abstract, printed on the workbook, printed on the PDF
 * and carried into the next bill's cumulative position — and written by nothing. No DTO accepted
 * them and no route set them, so each was permanently zero and the bill rendered a row headed
 * *Recovery of Diesel* that could only ever say nothing. A debit raised and applied appeared in the
 * register, said which bill it was recovered on, and did not move the payable by a rupee.
 *
 * ## Entered, not derived — and that is the point
 *
 * These are the figures a quantity surveyor decides. Which bucket a debit belongs in is a judgement
 * — diesel drawn, a civil debit, a mechanical one — and the register's own total is shown beside
 * these fields on the screen so a mismatch is visible rather than reconciled silently. Deriving
 * them would also leave mobilisation advance, performance security and theft withheld with no home
 * at all: none of those is a debit note.
 *
 * ## Every field optional, and omission means unchanged
 *
 * Omitting a field leaves it as it stands; sending `0` sets it to zero. A form that posted the
 * whole set every time would be indistinguishable from one that cleared the fields it did not
 * render, and these are money columns on a document somebody signs.
 *
 * ## What is NOT here
 *
 * `retentionAmount` and `tdsAmount` are computed from the frozen fractions against the work done,
 * and `workDone` from the claims. Accepting any of the three would let a bill state a retention its
 * own rate does not produce — the arithmetic would stop being checkable, which is the one property
 * an abstract has.
 */
export class SetBillAdjustmentsDto {
  /**
   * An amount held back from release this month, in block A beside the work done.
   *
   * Signed on purpose: a withholding that *reduces* the block is entered as a negative figure
   * rather than having its sign guessed by the abstract (FR-015a).
   */
  @ApiPropertyOptional({ example: '-12500.00' })
  @IsOptional()
  @IsNumberString()
  releaseWithheld?: string;

  @ApiPropertyOptional({ example: '69856.00' })
  @IsOptional()
  @IsNumberString()
  recoveryDiesel?: string;

  @ApiPropertyOptional({ example: '0.00' })
  @IsOptional()
  @IsNumberString()
  debitAgainstCivil?: string;

  @ApiPropertyOptional({ example: '0.00' })
  @IsOptional()
  @IsNumberString()
  otherRecoveries?: string;

  @ApiPropertyOptional({ example: '0.00' })
  @IsOptional()
  @IsNumberString()
  mechanicalDebit?: string;

  @ApiPropertyOptional({ example: '50000.00' })
  @IsOptional()
  @IsNumberString()
  mobilizationAdvance?: string;

  @ApiPropertyOptional({ example: '25000.00' })
  @IsOptional()
  @IsNumberString()
  performanceSecurity?: string;

  @ApiPropertyOptional({ example: '0.00' })
  @IsOptional()
  @IsNumberString()
  theftWithheld?: string;

  /**
   * What the one-time recoveries **total** across the contract (FR-020).
   *
   * Without it, a deduction that is fully recovered and one somebody entered as zero this month are
   * the same row. Recovered-to-date is the cumulative column; this is the other half, and it is why
   * "fully recovered" can be a fact rather than a wish.
   */
  @ApiPropertyOptional({ example: '500000.00' })
  @IsOptional()
  @IsNumberString()
  mobilizationAdvanceTotal?: string;

  @ApiPropertyOptional({ example: '250000.00' })
  @IsOptional()
  @IsNumberString()
  performanceSecurityTotal?: string;
}
