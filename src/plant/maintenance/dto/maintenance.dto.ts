import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  JobCardStatus,
  MaintenanceStatus,
  MaintenanceType,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
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

import { JobCardDto } from './job-card.dto';

export class CreateMaintenanceJobDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  equipmentId!: string;

  @ApiProperty({ enum: MaintenanceType })
  @IsEnum(MaintenanceType)
  type!: MaintenanceType;

  @ApiProperty({ example: 'Hydraulic hose burst on boom cylinder' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  description!: string;

  @ApiPropertyOptional({
    description:
      'The service schedule this job discharges, if it is a scheduled one',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  linkedServiceScheduleId?: string;

  @ApiPropertyOptional({
    type: JobCardDto,
    description: 'The job card, when the job is opened from the job card form',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => JobCardDto)
  card?: JobCardDto;
}

export class CloseMaintenanceJobDto {
  @ApiPropertyOptional({ description: 'Defaults to now' })
  @IsOptional()
  @IsISO8601()
  closedAt?: string;

  @ApiProperty({ description: 'Meter reading at the moment work finished' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  closingReading!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  partsDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  labourCost?: number;
}

export class ListMaintenanceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  equipmentId?: string;

  @ApiPropertyOptional({ enum: MaintenanceStatus })
  @IsOptional()
  @IsEnum(MaintenanceStatus)
  status?: MaintenanceStatus;

  @ApiPropertyOptional({ enum: MaintenanceType })
  @IsOptional()
  @IsEnum(MaintenanceType)
  type?: MaintenanceType;

  @ApiPropertyOptional({
    enum: JobCardStatus,
    description: "The job card's workflow status (039)",
  })
  @IsOptional()
  @IsEnum(JobCardStatus)
  jobCardStatus?: JobCardStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

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
}
