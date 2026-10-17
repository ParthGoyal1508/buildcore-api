import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** One item of PART-A: a heading over its service line (2026-10-15). */
export class HireOrderLineDto {
  @ApiProperty({ example: 'Hiring of Bolero Camper ZX for Toll plaza' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ example: 'LMV hire services-Months' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  description!: string;

  @ApiPropertyOptional({ example: '9966' })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  sacCode?: string;

  @ApiPropertyOptional({ example: 18, description: 'GST %' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxRate?: number;

  @ApiProperty({ example: 3 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  quantity!: number;

  @ApiProperty({ example: 'MON' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(12)
  uom!: string;

  @ApiProperty({ example: 240000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  rate!: number;

  @ApiPropertyOptional({
    description: 'The registered machine this line hires, when known',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  equipmentId?: string;
}

export class CreateHireOrderDto {
  @ApiProperty({ example: '2026-10-15' })
  @IsISO8601()
  date!: string;

  @ApiPropertyOptional({ description: 'The "Ref No." at the head' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  referenceNo?: string;

  @ApiProperty({ description: 'The supplier — a vendor of this company' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  vendorId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  pointOfDelivery?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;

  @ApiProperty({ type: [HireOrderLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HireOrderLineDto)
  lines!: HireOrderLineDto[];
}

/** Lines, when given, replace the order's lines. The number never changes. */
export class UpdateHireOrderDto extends PartialType(CreateHireOrderDto) {}

/** The list's filters and, since 036 K17, its optional paging. */
export class ListHireOrdersDto {
  @ApiPropertyOptional({ description: 'Cross-company callers only' })
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    description:
      'Send page (and optionally pageSize) to get { items, total, page, pageSize }. ' +
      'Without either, the response is the old bare array, capped at 200.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
