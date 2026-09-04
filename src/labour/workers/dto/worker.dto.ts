import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EngagementType, WorkerStatus } from '@prisma/client';
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
} from 'class-validator';

export class ListWorkersDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  skillCategoryId?: string;

  @ApiPropertyOptional({ enum: WorkerStatus })
  @IsOptional()
  @IsEnum(WorkerStatus)
  status?: WorkerStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

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

export class CreateWorkerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  companyId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  gender!: string;

  @ApiProperty({ example: '1990-05-20' })
  @IsDateString()
  dateOfBirth!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  skillCategoryId!: string;

  @ApiProperty({ enum: EngagementType })
  @IsEnum(EngagementType)
  engagementType!: EngagementType;

  @ApiPropertyOptional({
    description: 'Required when engagementType is contractor',
  })
  @IsOptional()
  @IsString()
  contractorId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  siteId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  aadhaarNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  bankAccount?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  rateOverride?: number;
}

export class DeactivateWorkerDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ example: '2026-09-30' })
  @IsDateString()
  lastWorkingDate!: string;
}

export class EnrolWorkerFaceDto {
  @ApiProperty({
    type: [String],
    description: 'Base64/data-URL enrolment photos',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  photos!: string[];
}
