import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EquipmentDisposalType, EquipmentScrapReason } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsBase64Payload } from '../../../common/uploads/base64-payload';

/** A rupee figure above this is a typing slip, not a machine. */
const MAX_AMOUNT = 1_000_000_000;

export const DISPOSAL_PAYMENT_MODES = [
  'cash',
  'cheque',
  'bank_transfer',
  'upi',
  'other',
] as const;

export class DisposeEquipmentDto {
  @ApiProperty({ enum: EquipmentDisposalType })
  @IsEnum(EquipmentDisposalType)
  type!: EquipmentDisposalType;

  @ApiProperty({ example: '2026-10-17' })
  @IsDateString()
  disposalDate!: string;

  @ApiPropertyOptional({
    enum: EquipmentScrapReason,
    description: 'Scrap only, required',
  })
  @IsOptional()
  @IsEnum(EquipmentScrapReason)
  scrapReason?: EquipmentScrapReason;

  @ApiPropertyOptional({
    description: 'Buyer (sale, required) or scrap vendor/buyer',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  counterpartyName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  buyerContact?: string;

  @ApiPropertyOptional({ enum: DISPOSAL_PAYMENT_MODES })
  @IsOptional()
  @IsIn(DISPOSAL_PAYMENT_MODES)
  paymentMode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  invoiceNumber?: string;

  @ApiPropertyOptional({
    description: 'Sale amount (required for a sale) or scrap value',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_AMOUNT)
  valueRealised?: number;

  @ApiPropertyOptional({
    description:
      "Book value on the disposal date. Ignored where the machine's depreciation gives one; " +
      'required for a sale where it does not.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_AMOUNT)
  bookValue?: number;

  @ApiProperty({ description: 'Who approved it, as written' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  approvedBy!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remarks?: string;

  @ApiPropertyOptional({ description: 'Base64 photo, invoice or agreement' })
  @IsOptional()
  @IsBase64Payload()
  attachment?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  attachmentName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  attachmentMime?: string;
}

export class DisposalPreviewDto {
  @ApiProperty({ example: '2026-10-17' })
  @IsDateString()
  disposalDate!: string;
}

export class ReverseDisposalDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

export class ListDisposalsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional({ enum: EquipmentDisposalType })
  @IsOptional()
  @IsEnum(EquipmentDisposalType)
  type?: EquipmentDisposalType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Months of the chart, default 12' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(36)
  months?: number;
}
