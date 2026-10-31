import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EngagementType, LabourGender, WorkerStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
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
  ValidateIf,
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

  @ApiPropertyOptional({
    enum: ['open', 'closed'],
    description:
      'Only workers whose NOC is still awaited (`open`) or already uploaded (`closed`) — ' +
      'the same open/closed rule `GET /nocs/status` reports (042).',
  })
  @IsOptional()
  @IsIn(['open', 'closed'])
  nocStatus?: 'open' | 'closed';

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

/**
 * 052: edits a worker's registration details. Every field is optional and an omitted one is left
 * as it is. Sending `null` clears an optional field (father's name, mobile, date of birth, skill,
 * contractor, Aadhaar, bank account, special rate); name, gender and engagement can be changed but
 * not cleared. The site is not here — moving a worker is a transfer.
 */
export class UpdateWorkerDto {
  @ApiPropertyOptional()
  @ValidateIf((o) => o.fullName !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({ enum: LabourGender })
  @ValidateIf((o) => o.gender !== undefined)
  @IsEnum(LabourGender)
  gender?: LabourGender;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fatherName?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '9876543210' })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, {
    message: 'Mobile number should be 10 digits, optionally starting with +91',
  })
  @MaxLength(200)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '1990-05-20' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  skillCategoryId?: string | null;

  @ApiPropertyOptional({ enum: EngagementType })
  @ValidateIf((o) => o.engagementType !== undefined)
  @IsEnum(EngagementType)
  engagementType?: EngagementType;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Required when the worker is (or becomes) contractor-engaged; ignored and cleared for a ' +
      'direct worker',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contractorId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  aadhaarNumber?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  bankAccount?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Special daily rate; null clears it. Changing it needs LABOUR_APPROVE, as site rates do.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(9_999_999_999.99)
  rateOverride?: number | null;
}

/** 052: moves an active worker to another site of the same company. */
export class TransferWorkerDto {
  @ApiProperty({ description: 'The site the worker moves to' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  siteId!: string;

  @ApiPropertyOptional({ example: 'Needed at the bridge site' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ContractorOptionsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;
}
