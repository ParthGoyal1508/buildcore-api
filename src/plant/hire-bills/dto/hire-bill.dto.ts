import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HireBillBasis, HireBillStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * `grossAmount`, `tdsRate`, `tdsAmount`, `netPayable`, `logbookHours` and
 * `variance` are all absent by design.
 *
 * FR-005: every one of them is computed server-side. A bill whose net payable is
 * whatever the person raising it typed is not a control, it is a form.
 */
export class CreateHireBillDto {
  @ApiProperty({ description: 'A hired machine — an owned one is refused' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  equipmentId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  vendorId!: string;

  @ApiPropertyOptional({
    description:
      'Hours (or km) the vendor has billed for. Required on an hours bill; on a monthly bill ' +
      'it defaults to the run between the start and ending readings.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  billedHours?: number;

  @ApiPropertyOptional({
    description:
      "Omit to take the effective Hire Rate for the machine's category on " +
      'billingPeriodFrom (FR-014). Supply one only to override it.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  rate?: number;

  @ApiProperty({ example: '2026-08-01' })
  @IsISO8601()
  billingPeriodFrom!: string;

  @ApiProperty({ example: '2026-08-31' })
  @IsISO8601()
  billingPeriodTo!: string;

  // ── The vehicle hiring bill (2026-10-15) ──

  @ApiPropertyOptional({
    enum: HireBillBasis,
    description: '`monthly`: a monthly rent pro-rated over the days billed.',
  })
  @IsOptional()
  @IsEnum(HireBillBasis)
  basis?: HireBillBasis;

  @ApiPropertyOptional({
    description: 'The hire order the bill is raised under',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  hireOrderId?: string;

  @ApiPropertyOptional({
    description: "The bill's own date; defaults to today",
    example: '2026-09-07',
  })
  @IsOptional()
  @IsISO8601()
  billDate?: string;

  @ApiPropertyOptional({ description: '"Reference Invoice No."' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  invoiceNo?: string;

  @ApiPropertyOptional({ example: 'RJ/2026-27/004' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  taxInvoiceRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  taxInvoiceDate?: string;

  @ApiPropertyOptional({ example: 'Monthly vehicle rent – FARANA' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({
    description: 'Days billed; defaults to the days in the period',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  periodDays?: number;

  @ApiPropertyOptional({ description: 'Monthly rent, on a monthly bill' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  monthlyRate?: number;

  @ApiPropertyOptional({
    description:
      'Agreed average — litres per hour, or km per litre on a km meter. Defaults from the ' +
      "category's fuel benchmark.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(9_999_999.999)
  agreedAverage?: number;

  @ApiPropertyOptional({ description: 'Defaults to the first logbook opening' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  startReading?: number;

  @ApiPropertyOptional({ description: 'Defaults to the last logbook closing' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  endReading?: number;

  @ApiPropertyOptional({
    description:
      '"Deduction Amount" — defaults to the diesel the company supplied in the period, at cost',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  deductionAmount?: number;

  @ApiPropertyOptional({ description: '"Debit / Hold Amount"' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  holdAmount?: number;
}

/**
 * Corrections to a bill still awaiting verification (2026-10-15): the printed references and the
 * deduction and hold. The figures it implies are recomputed; the machine, vendor and period stay.
 */
export class UpdateHireBillDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  billDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  invoiceNo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  taxInvoiceRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  taxInvoiceDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(9_999_999.999)
  agreedAverage?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  deductionAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  holdAmount?: number;
}

export class PayHireBillDto {
  @ApiPropertyOptional({
    example: '2026-09-10',
    description:
      'When the bill was paid (036: optional; defaults to today, IST).',
  })
  @IsOptional()
  @IsISO8601()
  paymentDate?: string;

  @ApiProperty({ example: 'NEFT/2026/0912' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  paymentReference!: string;
}

export class ListHireBillsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  equipmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string;

  @ApiPropertyOptional({ enum: HireBillStatus })
  @IsOptional()
  @IsEnum(HireBillStatus)
  status?: HireBillStatus;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: '036 K9: bills whose period overlaps periodFrom..periodTo.',
  })
  @IsOptional()
  @IsISO8601()
  periodFrom?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsISO8601()
  periodTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

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
}

/** The logbook over a prospective bill's period (036 K9). */
export class HireBillLogbookSummaryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  equipmentId!: string;

  @ApiProperty({ example: '2026-10-01' })
  @IsISO8601()
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  @IsISO8601()
  to!: string;
}
