import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PurchaseBillStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
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

export class CreatePurchaseDto {
  @ApiProperty({ description: 'The project store receiving the material' })
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  itemId!: string;

  @ApiProperty({ description: 'A vendor from the Partners module' })
  @IsString()
  @IsNotEmpty()
  vendorId!: string;

  @ApiProperty({ example: '2026-09-04', description: 'YYYY-MM-DD' })
  @IsDateString()
  date!: string;

  @ApiProperty({
    description: 'Must be positive — a zero-quantity purchase is a mistake',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  quantity!: number;

  @ApiProperty({ description: 'Per-unit rate in rupees' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rate!: number;

  @ApiPropertyOptional({
    description:
      'The bill, base64-encoded. Base64 in JSON rather than multipart, matching ' +
      "007's contractor documents — the codebase has one upload mechanism.",
  })
  @IsOptional()
  @IsString()
  billFile?: string;

  @ApiPropertyOptional({ example: 'application/pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  billContentType?: string;

  @ApiPropertyOptional({ description: 'The approved indent line this fulfils' })
  @IsOptional()
  @IsString()
  indentLineId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

/**
 * Quantity, rate, item, site and vendor are all absent by design: they are what the
 * stock ledger and the bill were computed from, and editing one in place would
 * leave both restating history. Correcting a purchase is delete plus re-create.
 */
export class UpdatePurchaseDto {
  @ApiPropertyOptional({ example: '2026-09-04' })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

export class ListPurchasesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  itemId?: string;

  @ApiPropertyOptional({ enum: PurchaseBillStatus })
  @IsOptional()
  @IsEnum(PurchaseBillStatus)
  paymentStatus?: PurchaseBillStatus;

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
