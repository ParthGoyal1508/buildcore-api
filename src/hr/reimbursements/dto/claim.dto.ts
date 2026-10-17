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
  Max,
  MaxLength,
} from 'class-validator';
import { IsBase64Payload } from '../../../common/uploads/base64-payload';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateClaimDto {
  @ApiProperty({ description: 'A `settings.ReimbursementCategory` id.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  categoryId: string;

  @ApiProperty({ example: 2450.5 })
  @Type(() => Number)
  // Two decimals: the column is DECIMAL(12,2), and accepting more here would let a
  // caller submit an amount the database then silently rounds to something else.
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(9_999_999_999.99)
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
    nullable: true,
    description:
      'Deprecated (036 F18): a client-sent storage reference no longer counts as a receipt — ' +
      'upload one in `receipt`. On an edit, `null` removes the receipt on file; any string is ' +
      'ignored and the receipt on file is kept.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  receiptRef?: string | null;

  @ApiPropertyOptional({
    description:
      'The receipt: a photo (JPEG, PNG, WebP) or, since 036 G5, a PDF — base64, optionally a data URL. ' +
      'Required above the category’s configured threshold (FR-030). Photos are normalised to JPEG.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @IsBase64Payload()
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
