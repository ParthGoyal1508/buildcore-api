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
  MaxLength,
  Min,
} from 'class-validator';

export class ListCandidatesDto {
  @ApiPropertyOptional() @IsOptional() @IsString() companyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() requisitionId?: string;
  @ApiPropertyOptional({ enum: CandidateStage })
  @IsOptional()
  @IsEnum(CandidateStage)
  stage?: CandidateStage;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
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

export class CreateCandidateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() companyId?: string;
  @ApiProperty() @IsString() @IsNotEmpty() requisitionId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(120) fullName!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(20) phone!: string;
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
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
  currentCtc?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  expectedCtc?: number;
  @ApiProperty({ enum: CandidateSource })
  @IsEnum(CandidateSource)
  source!: CandidateSource;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  referredByEmployeeId?: string;
}

export class UploadResumeDto {
  @ApiProperty({ description: 'Base64/data-URL resume (.pdf/.doc/.docx)' })
  @IsString()
  @IsNotEmpty()
  file!: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @IsNotEmpty()
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
  @ApiProperty() @IsString() @IsNotEmpty() rejectionReason!: string;
}

export class MarkNoShowDto {
  @ApiProperty() @IsString() @IsNotEmpty() reason!: string;
}
