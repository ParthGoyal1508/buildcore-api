import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateItemCategoryDto {
  @ApiProperty({
    description: 'Stored uppercase, so "Cement" and "CEMENT" are one category',
    example: 'CEMENT',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;
}

export class UpdateItemCategoryDto extends PartialType(CreateItemCategoryDto) {}

export class ListItemCategoriesDto {
  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  companyId?: string;
}
