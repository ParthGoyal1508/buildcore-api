import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RequisitionEmploymentType, RequisitionStatus } from '@prisma/client';
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
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListRequisitionsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  companyId?: string;
  @ApiPropertyOptional({ enum: RequisitionStatus })
  @IsOptional()
  @IsEnum(RequisitionStatus)
  status?: RequisitionStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  departmentId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  projectId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  page?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  pageSize?: number;
}

export class CreateRequisitionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  companyId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  departmentId!: string;
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  designationId!: string;

  @ApiProperty({ example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  positionCount!: number;

  @ApiProperty({ enum: RequisitionEmploymentType })
  @IsEnum(RequisitionEmploymentType)
  employmentType!: RequisitionEmploymentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  projectId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  siteId?: string;

  @ApiProperty({ example: '2026-11-01' })
  @IsDateString()
  targetJoiningDate!: string;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(999_999_999_999.99)
  budgetedCtcMin!: number;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(999_999_999_999.99)
  budgetedCtcMax!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  justification!: string;
}

export class RejectRequisitionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(2_000)
  reason!: string;
}
