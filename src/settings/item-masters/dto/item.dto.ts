import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ItemUnit } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateItemDto {
  @ApiProperty({ example: 'OPC 53 Grade Cement' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ description: 'An existing ItemCategory in the same company' })
  @IsString()
  @IsNotEmpty()
  categoryId!: string;

  @ApiProperty({ enum: ItemUnit, description: 'The eight units of FR-018' })
  @IsEnum(ItemUnit)
  unit!: ItemUnit;

  @ApiPropertyOptional({
    description:
      'Stock floor for this item. Omit for items that do not need one — a 0 would ' +
      'claim the item is exactly at its threshold rather than that it has none.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  reorderLevel?: number;

  @ApiPropertyOptional({ description: 'HS code for GST returns' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  hsnCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

/**
 * `code` is deliberately absent: it is allocated once from the company's ITEMS
 * series and renaming it would detach every historical purchase from the item it
 * describes.
 */
export class UpdateItemDto extends PartialType(CreateItemDto) {
  @ApiPropertyOptional({
    description: 'Retire an item without deleting its stock history',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/**
 * A DTO class rather than individual `@Query()` parameters, for the reason
 * `ListVendorsDto` records: with `transform: true`, Nest hands an absent value to
 * class-transformer along with the enum as its metatype and class-transformer
 * dereferences it. A DTO class is always instantiable.
 */
export class ListItemsDto {
  @ApiPropertyOptional({ description: 'Matches name, code or HSN code' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Omit to see both active and retired' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  active?: boolean;

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
