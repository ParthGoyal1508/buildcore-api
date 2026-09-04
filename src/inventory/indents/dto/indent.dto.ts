import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IndentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';

export class CreateIndentLineDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  itemId!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  requestedQuantity!: number;

  @ApiPropertyOptional({ description: 'The BOQ task group this is for' })
  @IsOptional()
  @IsString()
  activityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  boqItemId?: string;
}

export class CreateIndentDto {
  @ApiProperty({ description: 'The store the material is wanted at' })
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiProperty({ example: '2026-09-20' })
  @IsDateString()
  requiredByDate!: string;

  @ApiProperty({ description: 'Why the material is needed' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  justification!: string;

  @ApiProperty({ type: [CreateIndentLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateIndentLineDto)
  lines!: CreateIndentLineDto[];
}

export class ApproveIndentLineDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  lineId!: string;

  @ApiProperty({
    description:
      'May be below the requested quantity; when it is, `reductionReason` is required',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  approvedQuantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reductionReason?: string;
}

export class ApproveIndentDto {
  @ApiProperty({ type: [ApproveIndentLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ApproveIndentLineDto)
  lines!: ApproveIndentLineDto[];
}

/** Both rejection and cancellation require a reason (FR-026). A rejected request
 * with no stated reason is the thing the requester cannot act on. */
export class IndentDecisionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class MarkProcurementNeededDto {
  @ApiProperty({ type: [String], description: 'Indent line ids' })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  lineIds!: string[];
}

export class ListIndentsDto {
  @ApiPropertyOptional({ enum: IndentStatus })
  @IsOptional()
  @IsEnum(IndentStatus)
  status?: IndentStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  itemId?: string;

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
