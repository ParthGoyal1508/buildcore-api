import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BillTaxBasis } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsEnum,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One item on a debit note. Its amount is quantity × rate, computed on the server. */
export class DebitNoteLineDto {
  @ApiProperty({ example: 'Solar Panel (335 W)' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description: string;

  @ApiPropertyOptional({
    example: '7 Nos. Water pump location & 4 Nos. Deck Light location',
    description: 'The line printed under the item name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  specification?: string;

  @ApiPropertyOptional({ example: 'Nos.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @ApiProperty({ example: '11' })
  @IsNumberString()
  quantity: string;

  @ApiProperty({ example: '13550.00' })
  @IsNumberString()
  rate: string;
}

/**
 * A debit note on a subcontractor (2026-10-15), per the client's "Parth Realcon DV-04, debit
 * note" format. The party, its GSTIN and its vendor code come from the work order; the number is
 * allocated on the server (`2026-27/001`); every amount is computed, none is sent.
 */
export class RaiseDebitNoteDto {
  @ApiProperty({
    description: 'The subcontractor’s work order on this project.',
  })
  @IsString()
  workOrderId: string;

  @ApiPropertyOptional({
    example: '2026-06-29',
    description: 'Defaults to today.',
  })
  @IsOptional()
  @IsISO8601()
  noteDate?: string;

  @ApiPropertyOptional({
    example: 'O&M of Highway',
    description: 'Defaults to the work order’s description of the work.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  natureOfWork?: string;

  @ApiProperty({
    example: '18',
    description: 'GST on the work-done amount, in percent.',
  })
  @IsNumberString()
  gstPercent: string;

  @ApiProperty({
    enum: BillTaxBasis,
    description: '`intra_state` prints CGST + SGST; `inter_state` prints IGST.',
  })
  @IsEnum(BillTaxBasis)
  taxBasis: BillTaxBasis;

  @ApiProperty({ type: [DebitNoteLineDto] })
  @ValidateNested({ each: true })
  @Type(() => DebitNoteLineDto)
  @ArrayMinSize(1)
  lines: DebitNoteLineDto[];
}
