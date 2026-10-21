import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JobCardPaymentMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { IsBase64Payload } from '../../../common/uploads';

/** Rupees, two decimals, more than nothing. */
function Money(): PropertyDecorator {
  return (target, key) => {
    Type(() => Number)(target, key);
    IsNumber({ maxDecimalPlaces: 2 })(target, key);
    Min(0.01)(target, key);
    Max(9_999_999_999.99)(target, key);
  };
}

/** The workshop's quotation (039): required to submit, not to save a draft. */
export class JobCardQuotationDto {
  @ApiProperty({ description: 'The quoted amount, rupees' })
  @Money()
  amount!: number;

  @ApiPropertyOptional({
    description:
      'The quotation, base64 — PDF, image, xlsx or docx up to 10 MB. Leave out to keep the one ' +
      'already uploaded and change only the amount.',
  })
  @IsOptional()
  @IsBase64Payload()
  file?: string;

  @ApiPropertyOptional({ example: 'Quotation - Sai Motors.pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}

/** The workshop's final bill, uploaded by site once Head Office has approved the card. */
export class JobCardFinalBillDto {
  @ApiProperty({ example: 'SM/2026/0412' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  billNumber!: string;

  @ApiProperty({ example: '2026-10-21' })
  @IsISO8601({ strict: true })
  billDate!: string;

  @ApiProperty({ description: 'The bill amount, rupees' })
  @Money()
  amount!: number;

  @ApiProperty({
    description:
      'The bill copy, base64 — PDF, image, xlsx or docx up to 10 MB.',
  })
  @IsBase64Payload()
  file!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}

/**
 * One payment Head Office made against the final bill. `mode` is the field `CashEntryInterceptor`
 * reads, so a cash payment needs `CASH_ENTRY` and is refused outright while the company hides cash.
 */
export class RecordJobCardPaymentDto {
  @ApiProperty({ description: 'Rupees paid in this instalment' })
  @Money()
  amount!: number;

  @ApiProperty({ example: '2026-10-21' })
  @IsISO8601({ strict: true })
  paidOn!: string;

  @ApiProperty({ enum: JobCardPaymentMode })
  @IsEnum(JobCardPaymentMode)
  mode!: JobCardPaymentMode;

  @ApiPropertyOptional({ description: 'UTR, cheque or UPI reference' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;

  @ApiPropertyOptional({ description: 'Payment proof, base64 — optional' })
  @IsOptional()
  @IsBase64Payload()
  proofFile?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  proofFileName?: string;
}
