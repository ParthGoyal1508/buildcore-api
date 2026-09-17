import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMode, PurchaseBillStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBase64,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * No `allocations` array by design (research.md §7). Allocation is automatic and
 * FIFO on the server; letting a client name the bills would put the same decision
 * in two places, and the client's view of which bills are outstanding is a snapshot
 * that another payment may already have invalidated.
 */
export class CreatePaymentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  vendorId!: string;

  @ApiProperty({ description: 'In rupees' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiProperty({ example: '2026-09-04' })
  @IsDateString()
  date!: string;

  @ApiProperty({ enum: PaymentMode })
  @IsEnum(PaymentMode)
  paymentMode!: PaymentMode;

  @ApiProperty({ description: 'UTR, cheque number or UPI reference' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  referenceNumber!: string;
}

export class ListPaymentsDto {
  @ApiPropertyOptional({
    description:
      'FR-021. `true` lists only payments with no transaction proof attached; `false` ' +
      'only those with one. Omit for both.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : undefined,
  )
  @IsBoolean()
  missingProof?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiPropertyOptional({ enum: PaymentMode })
  @IsOptional()
  @IsEnum(PaymentMode)
  paymentMode?: PaymentMode;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsOptional()
  @IsString()
  companyId?: string;
}

export class ListBillsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiPropertyOptional({
    enum: PurchaseBillStatus,
    description: 'Omit to see every status',
  })
  @IsOptional()
  @IsEnum(PurchaseBillStatus)
  paymentStatus?: PurchaseBillStatus;

  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsOptional()
  @IsString()
  companyId?: string;
}

/**
 * The RTGS advice or transaction confirmation behind a payment (017 US7, FR-020).
 *
 * Base64 rather than multipart, matching every other document upload in this product:
 * 015 established that the web client has no FormData anywhere, and one transport for
 * uploads is worth more than a marginally smaller request body.
 */
export class AttachPaymentProofDto {
  @ApiProperty({ description: 'The advice, base64-encoded.' })
  @IsBase64()
  data: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @MaxLength(100)
  contentType: string;
}
