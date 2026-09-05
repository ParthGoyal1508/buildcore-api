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
  MaxLength,
  Min,
} from 'class-validator';

export class ListRequisitionsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() companyId?: string;
  @ApiPropertyOptional({ enum: RequisitionStatus })
  @IsOptional()
  @IsEnum(RequisitionStatus)
  status?: RequisitionStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() projectId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export class CreateRequisitionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() companyId?: string;

  @ApiProperty() @IsString() @IsNotEmpty() departmentId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() designationId!: string;

  @ApiProperty({ example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  positionCount!: number;

  @ApiProperty({ enum: RequisitionEmploymentType })
  @IsEnum(RequisitionEmploymentType)
  employmentType!: RequisitionEmploymentType;

  @ApiPropertyOptional() @IsOptional() @IsString() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() siteId?: string;

  @ApiProperty({ example: '2026-11-01' })
  @IsDateString()
  targetJoiningDate!: string;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  budgetedCtcMin!: number;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  budgetedCtcMax!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  justification!: string;
}

export class RejectRequisitionDto {
  @ApiProperty() @IsString() @IsNotEmpty() reason!: string;
}
