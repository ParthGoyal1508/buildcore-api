import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EngagementType, LabourGender, WorkerStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsBase64Payload } from '../../../common/uploads/base64-payload';

import { ENROLMENT_PHOTOS } from '../../constants/labour.constants';

/** Ten digits, optionally after +91 / 91 / 0, spaces and dashes allowed. */
const PHONE_PATTERN = /^(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}$/;

export class ListWorkersDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  siteId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  skillCategoryId?: string;

  @ApiPropertyOptional({ enum: WorkerStatus })
  @IsOptional()
  @IsEnum(WorkerStatus)
  status?: WorkerStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

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

export class CreateWorkerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ enum: LabourGender })
  @IsEnum(LabourGender)
  gender!: LabourGender;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fatherName?: string;

  @ApiPropertyOptional({ example: '9876543210' })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, {
    message: 'Mobile number should be 10 digits, optionally starting with +91',
  })
  @MaxLength(200)
  phone?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  siteId!: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Base64 face photos (3 to 5). Sent with the registration so a labour is never left ' +
      'registered without a face to match.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(ENROLMENT_PHOTOS.min)
  @ArrayMaxSize(ENROLMENT_PHOTOS.max)
  @IsString({ each: true })
  @IsBase64Payload({ each: true })
  photos?: string[];

  // Optional since 031 — kept for the office, which may know them.
  @ApiPropertyOptional({ example: '1990-05-20' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  skillCategoryId?: string;

  @ApiPropertyOptional({ enum: EngagementType, default: EngagementType.direct })
  @IsOptional()
  @IsEnum(EngagementType)
  engagementType?: EngagementType;

  @ApiPropertyOptional({
    description: 'Required when engagementType is contractor',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contractorId?: string;

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
  @Max(9_999_999_999.99)
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
  @ArrayMinSize(ENROLMENT_PHOTOS.min)
  @ArrayMaxSize(ENROLMENT_PHOTOS.max)
  @IsString({ each: true })
  @IsBase64Payload({ each: true })
  photos!: string[];
}
