import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ItemUnit } from '@prisma/client';
import { Type } from 'class-transformer';
import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
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

/** One sub-item of a composite: how much of it, in its own unit, goes into one unit of the mix. */
export class CompositeComponentDto {
  @ApiProperty({ description: 'An active Item in the same company' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  itemId!: string;

  @ApiProperty({ example: 0.827, description: 'Up to 6 decimal places' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @IsPositive()
  @Max(999_999_999_999)
  qtyPerUnit!: number;
}

/**
 * A composite item (039): a mix issued as its sub-items in fixed proportions — "DLC Concrete for
 * plant foundation", per 1 CUM: Cement 0.08 MT, Crusher Dust 0.827 MT, …
 */
export class CreateCompositeItemDto {
  @ApiProperty({ example: 'DLC Concrete for plant foundation' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: ItemUnit, description: 'The unit the mix is issued in' })
  @IsEnum(ItemUnit)
  unit!: ItemUnit;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ type: [CompositeComponentDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CompositeComponentDto)
  components!: CompositeComponentDto[];
}

/** `components`, when sent, replaces the whole list. Past issues keep the quantities they deducted. */
export class UpdateCompositeItemDto extends PartialType(
  CreateCompositeItemDto,
) {
  @ApiPropertyOptional({
    description:
      'Retire a composite that has been issued instead of deleting it',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListCompositeItemsDto {
  @ApiPropertyOptional({ description: 'Matches the name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Omit to see both active and retired' })
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  active?: boolean;

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
