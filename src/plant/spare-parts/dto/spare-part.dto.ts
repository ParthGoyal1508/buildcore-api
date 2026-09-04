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
  compatibleCategoryIds?: string[];

  @ApiPropertyOptional({
    description:
      'A feature 009 inventory item this part is also stocked as. The two stocks ' +
      'stay independent; declaring the link is what makes the divergence visible.',
  })
  @IsOptional()
  @IsString()
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
  quantity!: number;

  @ApiProperty({ description: 'Rupees per unit on this receipt' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  rate!: number;

  @ApiProperty({ example: '2026-09-04' })
  @IsISO8601()
  receiptDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
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
  sparePartId!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
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
  search?: string;

  @ApiPropertyOptional({
    description: 'Parts compatible with this equipment category',
  })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({
    description: 'Only parts at or below their reorder level',
  })
  @IsOptional()
  @IsString()
  belowReorder?: string;

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
