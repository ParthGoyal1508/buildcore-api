import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  InterviewMode,
  InterviewOutcome,
  InterviewRoundType,
  InterviewStatus,
} from '@prisma/client';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListInterviewsDto {
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
  candidateId?: string;
  @ApiPropertyOptional({ enum: InterviewStatus })
  @IsOptional()
  @IsEnum(InterviewStatus)
  status?: InterviewStatus;
}

export class ScheduleInterviewDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  @ApiProperty({ example: 1 })
  @IsInt()
  @Max(2_147_483_647)
  roundNumber!: number;
  @ApiProperty({ enum: InterviewRoundType })
  @IsEnum(InterviewRoundType)
  roundType!: InterviewRoundType;
  @ApiProperty() @IsDateString() scheduledAt!: string;
  @ApiProperty({ enum: InterviewMode })
  @IsEnum(InterviewMode)
  mode!: InterviewMode;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  interviewerEmployeeIds!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;
}

export class InterviewFeedbackDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  interviewerEmployeeId!: string;
  @ApiProperty({ enum: InterviewOutcome })
  @IsEnum(InterviewOutcome)
  outcome!: InterviewOutcome;
  @ApiProperty({ example: 8 }) @IsInt() @Min(1) @Max(10) score!: number;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(2000) comments!: string;
}

export class RescheduleInterviewDto {
  @ApiProperty() @IsDateString() scheduledAt!: string;
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(2_000)
  reason!: string;
}
