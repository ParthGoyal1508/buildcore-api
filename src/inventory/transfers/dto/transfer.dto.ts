import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TransferStatus } from '@prisma/client';
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

export class CreateTransferDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  fromSiteId!: string;

  @ApiProperty({ description: 'Must differ from fromSiteId' })
  @IsString()
  @IsNotEmpty()
  toSiteId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  itemId!: string;

  @ApiProperty({ example: '2026-09-04' })
  @IsDateString()
  date!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;

  // ── The stock transfer slip and delivery challan (2026-10-15) ──

  @ApiPropertyOptional({ example: 'RJ26-GA-1234' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  vehicleNo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  transporter?: string;

  @ApiPropertyOptional({ description: 'Indent / PO / dispatch reference' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  dispatchReference?: string;

  @ApiPropertyOptional({ description: 'Transfer request number' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  requestNo?: string;

  @ApiPropertyOptional({ example: '2026-10-17' })
  @IsOptional()
  @IsDateString()
  expectedArrival?: string;

  @ApiPropertyOptional({ description: 'Reason for transfer' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UpdateTransferDto {
  @ApiProperty({
    enum: TransferStatus,
    description: 'pending → in_transit → received, in that order',
  })
  @IsEnum(TransferStatus)
  status!: TransferStatus;

  @ApiPropertyOptional({
    description:
      'Counted at the receiving store, when marking it received — the slip prints the difference',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  receivedQuantity?: number;
}

export class ListTransfersDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fromSiteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  toSiteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  itemId?: string;

  @ApiPropertyOptional({ enum: TransferStatus })
  @IsOptional()
  @IsEnum(TransferStatus)
  status?: TransferStatus;

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
