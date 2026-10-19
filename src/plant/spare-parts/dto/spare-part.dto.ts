import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
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

export class CreateSparePartDto {
  @ApiProperty({ example: 'HF-6177' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  partNumber!: string;

  @ApiProperty({ example: 'Hydraulic return filter' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'NOS' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  unitOfMeasure!: string;

  @ApiPropertyOptional({
    description: 'Stock floor. Omit for a part that needs none.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  reorderLevel?: number;

  @ApiPropertyOptional({
    description:
      'Equipment categories this part fits. Empty means unrestricted. A populated ' +
      "list that excludes a machine's category flags consumption but never blocks it.",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  compatibleCategoryIds?: string[];

  @ApiPropertyOptional({
    description:
      'A feature 009 inventory item this part is also stocked as. The two stocks ' +
      'stay independent; declaring the link is what makes the divergence visible.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  linkedInventoryItemId?: string;
}

export class UpdateSparePartDto extends PartialType(CreateSparePartDto) {
  @ApiPropertyOptional({
    description: 'Retire a part without deleting its history',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ReceiveSparePartDto {
  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(999_999_999_999_999)
  quantity!: number;

  @ApiProperty({ description: 'Rupees per unit on this receipt' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(9_999_999_999.99)
  rate!: number;

  @ApiProperty({ example: '2026-09-04' })
  @IsISO8601()
  receiptDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendorId?: string;

  @ApiPropertyOptional({ example: 'INV-2291' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  billReference?: string;
}

export class ConsumeSparePartDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sparePartId!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(999_999_999_999_999)
  quantity!: number;

  @ApiPropertyOptional({ description: 'Defaults to today' })
  @IsOptional()
  @IsISO8601()
  consumedOn?: string;
}

export class ReverseConsumptionDto {
  @ApiProperty({
    description: 'Why the consumption is being undone. Required (FR-019).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListSparePartsDto {
  @ApiPropertyOptional({ description: 'Matches part number or name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    description: 'Parts compatible with this equipment category',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  categoryId?: string;

  @ApiPropertyOptional({
    description: 'Only parts at or below their reorder level',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  belowReorder?: string;

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
