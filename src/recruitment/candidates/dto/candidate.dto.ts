import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CandidateSource, CandidateStage } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsBase64Payload } from '../../../common/uploads/base64-payload';

export class ListCandidatesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  companyId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  requisitionId?: string;
  @ApiPropertyOptional({ enum: CandidateStage })
  @IsOptional()
  @IsEnum(CandidateStage)
  stage?: CandidateStage;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
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

export class CreateCandidateDto {
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
  requisitionId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(120) fullName!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(20) phone!: string;
  @ApiProperty() @IsEmail() email!: string;
  /**
   * Both printed on the offer letter and carried onto the employee at joining
   * (`address` becomes their permanent address). Optional: a candidate is often
   * entered from a phone call, and the letter lets HR type what is missing.
   */
  @ApiPropertyOptional({ description: 'Father’s name, as letters print it.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fatherName?: string;
  @ApiPropertyOptional({ description: 'Postal address, one line.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(999.9)
  totalExperienceYears!: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  currentEmployer?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999.99)
  currentCtc?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999.99)
  expectedCtc?: number;
  @ApiProperty({ enum: CandidateSource })
  @IsEnum(CandidateSource)
  source!: CandidateSource;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  referredByEmployeeId?: string;
}

export class UploadResumeDto {
  @ApiProperty({ description: 'Base64/data-URL resume (.pdf/.doc/.docx)' })
  @IsString()
  @IsNotEmpty()
  @IsBase64Payload()
  file!: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  contentType!: string;
}

export class TransitionStageDto {
  @ApiProperty({ enum: CandidateStage })
  @IsEnum(CandidateStage)
  stage!: CandidateStage;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}

export class RejectCandidateDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(2_000)
  rejectionReason!: string;
}

export class MarkNoShowDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(2_000)
  reason!: string;
}
