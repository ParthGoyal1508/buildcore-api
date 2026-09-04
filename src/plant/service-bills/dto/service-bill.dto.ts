import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ServiceBillPaymentStatus, ServiceBillStatus } from '@prisma/client';
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
 * `tdsAmount` and `netPayable` are absent by design (FR-021) — the same rule
 * `CreateHireBillDto` follows. A bill whose net payable is whatever the person
 * entering it typed is a form, not a control.
 */
export class CreateServiceBillDto {
  @ApiProperty({
    description:
      'The maintenance job this invoice covers. May already be closed.',
  })
  @IsString()
  @IsNotEmpty()
  maintenanceJobId!: string;

  @ApiProperty({ description: 'The workshop' })
  @IsString()
  @IsNotEmpty()
  vendorId!: string;

  @ApiProperty({ example: 'SVC/2026/0421' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  billNumber!: string;

  @ApiProperty({ example: '2026-09-02' })
  @IsISO8601()
  billDate!: string;

  @ApiProperty({ description: 'Rupees, before tax' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  grossAmount!: number;

  @ApiPropertyOptional({ description: 'GST or equivalent, in rupees' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxAmount?: number;

  @ApiPropertyOptional({
    description:
      "Omit to take the vendor's own TDS rate from Partners. Supply one only to " +
      'override it for this bill.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  tdsPercent?: number;
}

export class PayServiceBillDto {
  @ApiProperty({ example: '2026-09-20' })
  @IsISO8601()
  paidOn!: string;

  @ApiProperty({
    description:
      'Rupees actually paid. Less than the net payable marks the bill partially paid.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  paidAmount!: number;

  @ApiProperty({ example: 'NEFT/2026/1188' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  paymentReference!: string;
}

export class ListServiceBillsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiPropertyOptional({ description: 'Bills against jobs on this machine' })
  @IsOptional()
  @IsString()
  equipmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  maintenanceJobId?: string;

  @ApiPropertyOptional({ enum: ServiceBillStatus })
  @IsOptional()
  @IsEnum(ServiceBillStatus)
  status?: ServiceBillStatus;

  @ApiPropertyOptional({ enum: ServiceBillPaymentStatus })
  @IsOptional()
  @IsEnum(ServiceBillPaymentStatus)
  paymentStatus?: ServiceBillPaymentStatus;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsISO8601()
  to?: string;

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
