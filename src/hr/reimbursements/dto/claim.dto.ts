import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ReimbursementClaimStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateClaimDto {
  @ApiProperty({ description: 'A `settings.ReimbursementCategory` id.' })
  @IsString()
  @IsNotEmpty()
  categoryId: string;

  @ApiProperty({ example: 2450.5 })
  @Type(() => Number)
  // Two decimals: the column is DECIMAL(12,2), and accepting more here would let a
  // caller submit an amount the database then silently rounds to something else.
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @ApiProperty({ example: '2026-08-14' })
  @Matches(DATE_ONLY, { message: 'expenseDate must be a YYYY-MM-DD date' })
  expenseDate: string;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;

  @ApiPropertyOptional({
    description:
      'Storage reference for the uploaded receipt. Required above the category’s configured threshold (FR-030).',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  receiptRef?: string;

  @ApiPropertyOptional({
    description:
      'A base64-encoded receipt image (optionally a data URL), stored server-side in the same request and turned into `receiptRef`. Supply this or `receiptRef`, not both — this wins if both are sent.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  receipt?: string;

  @ApiPropertyOptional({
    enum: ['draft', 'submitted'],
    default: 'submitted',
    description:
      'A draft stays editable; a submitted claim enters the review queue.',
  })
  @IsOptional()
  @IsIn(['draft', 'submitted'])
  status?: 'draft' | 'submitted';
}

/** Every create field, all optional — an edit changes what it names and leaves the
 * rest as filed. */
export class UpdateClaimDto extends PartialType(CreateClaimDto) {}

export class ClaimQueryDto {
  @ApiPropertyOptional({ enum: ReimbursementClaimStatus })
  @IsOptional()
  @IsIn(Object.values(ReimbursementClaimStatus))
  status?: ReimbursementClaimStatus;
}
