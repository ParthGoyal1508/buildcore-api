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

  /**
   * The delivery photographed at the gate, base64-encoded (028 FR-017).
   *
   * **Optional here, and that is the decision rather than an oversight.** FR-017 makes the bill and
   * the photograph compulsory *before approval*, never at creation: a storekeeper photographing a
   * load at dusk with no signal must still be able to record that it arrived, and a rule that
   * refuses the record is a rule that loses the delivery.
   *
   * The gate that enforces it does not exist yet — **a purchase has no approval step of any kind**.
   * `ACTION_PURCHASE_RATE_CHANGE` is the inventory module's first approval and it governs a rate,
   * not a purchase. So this ships the capability and the column; the compulsion attaches to the
   * approval when a purchase gains one. Recorded here rather than left as a silent gap, because a
   * field that looks required and is not is worse than one that is plainly optional.
   */
  @ApiPropertyOptional({
    description:
      'The delivery photograph, base64-encoded. Required before approval once a purchase has an ' +
      'approval step; optional today because it has none (028 FR-017).',
  })
  @IsOptional()
  @IsString()
  photoFile?: string;

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
