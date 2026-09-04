import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HireBillStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
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
  equipmentId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  vendorId!: string;

  @ApiProperty({ description: 'Hours (or km) the vendor has billed for' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  billedHours!: number;

  @ApiPropertyOptional({
    description:
      "Omit to take the effective Hire Rate for the machine's category on " +
      'billingPeriodFrom (FR-014). Supply one only to override it.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rate?: number;

  @ApiProperty({ example: '2026-08-01' })
  @IsISO8601()
  billingPeriodFrom!: string;

  @ApiProperty({ example: '2026-08-31' })
  @IsISO8601()
  billingPeriodTo!: string;
}

export class PayHireBillDto {
  @ApiProperty({ example: '2026-09-10' })
  @IsISO8601()
  paymentDate!: string;

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
  equipmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiPropertyOptional({ enum: HireBillStatus })
  @IsOptional()
  @IsEnum(HireBillStatus)
  status?: HireBillStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

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
}
