import { ApiPropertyOptional } from '@nestjs/swagger';
import { VendorType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/**
 * Query parameters for the vendor list.
 *
 * A DTO class rather than individual `@Query('type') type?: VendorType` parameters.
 * Feature 005 shipped two endpoints written the second way and both returned 500
 * whenever the parameter was absent: with `transform: true`, Nest's ValidationPipe
 * hands the undefined value to class-transformer along with the enum as its
 * metatype, and class-transformer dereferences it. A DTO class is always
 * instantiable, so the absent case is simply an object with undefined fields.
 */
export class ListVendorsDto {
  @ApiPropertyOptional({ description: 'Matches name, code or GSTIN' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: VendorType })
  @IsOptional()
  @IsEnum(VendorType)
  type?: VendorType;

  @ApiPropertyOptional({ description: 'Omit to see both active and inactive' })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
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
