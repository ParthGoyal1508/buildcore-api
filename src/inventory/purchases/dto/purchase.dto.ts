import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PurchaseBillStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsBase64Payload } from '../../../common/uploads/base64-payload';

/** The GRN form's tick boxes, in its order. */
export const GRN_CONDITIONS = [
  'Good',
  'Damaged',
  'Short',
  'Under Inspection',
] as const;

/**
 * The GRN form's own fields (2026-10-15): the supplier's challan and the vehicle it came on, the
 * quantities counted, accepted and rejected, the condition, and any batch or discrepancy note.
 * Recorded, not enforced — stock moves by the purchase quantity, which is what was billed.
 */
export class GrnDetailsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  challanNo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  vehicleNo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  receivedQuantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  acceptedQuantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  rejectedQuantity?: number;

  @ApiPropertyOptional({ enum: GRN_CONDITIONS })
  @IsOptional()
  @IsIn(GRN_CONDITIONS)
  condition?: string;

  @ApiPropertyOptional({ description: 'Batch / make / specification' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  batchDetails?: string;

  @ApiPropertyOptional({ description: 'Remarks / discrepancy details' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  discrepancy?: string;
}

export class CreatePurchaseDto {
  @ApiProperty({ description: 'The project store receiving the material' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  siteId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  itemId!: string;

  @ApiProperty({ description: 'A vendor from the Partners module' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
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
  @Max(999_999_999_999_999)
  quantity!: number;

  @ApiProperty({ description: 'Per-unit rate in rupees' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  rate!: number;

  @ApiPropertyOptional({
    description:
      'The bill, base64-encoded. Base64 in JSON rather than multipart, matching ' +
      "007's contractor documents — the codebase has one upload mechanism.",
  })
  @IsOptional()
  @IsString()
  @IsBase64Payload()
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
  @IsBase64Payload()
  photoFile?: string;

  @ApiPropertyOptional({ example: 'application/pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  billContentType?: string;

  @ApiPropertyOptional({ description: 'The approved indent line this fulfils' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  indentLineId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;

  @ApiPropertyOptional({
    type: GrnDetailsDto,
    description: 'What the goods receipt note records at the gate (2026-10-15)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => GrnDetailsDto)
  grn?: GrnDetailsDto;
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
  @MaxLength(100)
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
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
  @Max(2_147_483_647)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  pageSize?: number;

  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}
