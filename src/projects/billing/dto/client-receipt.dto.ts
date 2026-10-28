import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClientHoldKind, PaymentInstrument } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const MAX_MONEY = 999_999_999_999_999;

/** One amount field: rupees, two decimals, never negative. */
function Money(): PropertyDecorator {
  return (target, key) => {
    Type(() => Number)(target, key);
    IsNumber({ maxDecimalPlaces: 2 })(target, key);
    Min(0)(target, key);
    Max(MAX_MONEY)(target, key);
  };
}

/**
 * Money a client paid against one of our bills, with what it held back (048).
 *
 * `amount` is what reached the bank. The deductions are what the client kept: retention and CPBG
 * are **our money the client is holding**, and add to the held-by-client balance; TDS is a tax
 * credit and "other" is a deduction recorded with its reason. Together they settle the bill.
 */
export class RecordClientReceiptDto {
  @ApiProperty({ example: '2026-10-28' })
  @IsDateString()
  receivedOn!: string;

  @ApiProperty({ description: 'What actually arrived in the bank.' })
  @Money()
  amount!: number;

  @ApiPropertyOptional({ description: 'Retention withheld from this payment.' })
  @IsOptional()
  @Money()
  retentionAmount?: number;

  @ApiPropertyOptional({
    description:
      'Contract performance bank guarantee deducted from this payment, in place of a PBG.',
  })
  @IsOptional()
  @Money()
  cpbgAmount?: number;

  @ApiPropertyOptional({ description: 'Tax deducted at source.' })
  @IsOptional()
  @Money()
  tdsAmount?: number;

  @ApiPropertyOptional({
    description:
      'Any other deduction — record what it was in `otherDeductionNote`.',
  })
  @IsOptional()
  @Money()
  otherDeduction?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  otherDeductionNote?: string;

  @ApiProperty({ enum: PaymentInstrument })
  @IsEnum(PaymentInstrument)
  instrument!: PaymentInstrument;

  @ApiPropertyOptional({ description: 'UTR, cheque number.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  remarks?: string;
}

/** Retention released, or CPBG refunded, by the client (048). */
export class RecordClientHoldReleaseDto {
  @ApiProperty({ enum: ClientHoldKind })
  @IsEnum(ClientHoldKind)
  kind!: ClientHoldKind;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY)
  amount!: number;

  @ApiProperty({ example: '2026-10-28' })
  @IsDateString()
  releasedOn!: string;

  @ApiProperty({
    description:
      'Why now — completion, end of the defect liability period, PBG submitted. Required: it is ' +
      'the first question anybody asks of a release six months later.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1_000)
  reason!: string;

  @ApiPropertyOptional({
    description:
      'For a CPBG refund: the PBG (a bank guarantee of type PBG on a tender linked to this ' +
      'project) whose submission it follows.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankGuaranteeId?: string;
}
