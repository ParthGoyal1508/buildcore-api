import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Recording one debit against a project (023 FR-036).
 *
 * The dimensions are each optional because the real register uses different ones per line — a
 * missing cable has a length, a missing camera has a count, and a reinstatement has an area. Forcing
 * all four would make somebody enter a 1 to get past the form, and a 1 that means "not applicable"
 * is indistinguishable from a 1 that means one.
 */
export class RecordDebitDto {
  @ApiPropertyOptional({
    example: 'Debit against the ATMS Equipment Missing at site',
    description:
      'The heading this debit is grouped under (FR-040). The register is read by heading, not as a ' +
      'flat list, because the heading is what tells a subcontractor which dispute a line belongs to.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  groupHeading?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  description: string;

  @ApiPropertyOptional({ example: 'KM.226 LHS' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @ApiPropertyOptional({ description: 'Count, where the debit has one.' })
  @IsOptional()
  @IsNumberString()
  nos?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  length?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  width?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  quantity?: string;

  @ApiPropertyOptional({ example: 'Mtr' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @ApiProperty({ example: '1250.00' })
  @IsNumberString()
  rate: string;

  @ApiProperty({ example: '125000.00' })
  @IsNumberString()
  amount: string;

  @ApiProperty({
    example: '147500.00',
    description:
      'The amount including tax, **entered rather than derived** (FR-036). The real register shows ' +
      'both, and the tax on a debit is not always the bill’s own rate — a stolen item is charged ' +
      'at the rate it was bought at. Deriving it would quietly re-rate every historical debit the ' +
      'first time a statute changed.',
  })
  @IsNumberString()
  amountWithTax: string;
}
