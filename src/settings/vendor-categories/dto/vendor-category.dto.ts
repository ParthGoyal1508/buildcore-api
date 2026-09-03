import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateVendorCategoryDto {
  @ApiProperty({ description: 'Unique within the company, case-sensitive' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateVendorCategoryDto extends PartialType(
  CreateVendorCategoryDto,
) {}
