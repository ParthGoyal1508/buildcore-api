import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResignationReasonCategory, ResignationStatus } from '@prisma/client';
import {
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

export class ListResignationsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  companyId?: string;
  @ApiPropertyOptional({ enum: ResignationStatus })
  @IsOptional()
  @IsEnum(ResignationStatus)
  status?: ResignationStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  employeeId?: string;
}

export class CreateResignationDto {
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
  employeeId!: string;
  @ApiProperty({ example: '2026-11-01' })
  @IsDateString()
  resignationDate!: string;
  @ApiProperty({ enum: ResignationReasonCategory })
  @IsEnum(ResignationReasonCategory)
  reasonCategory!: ResignationReasonCategory;
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reasonDetail!: string;
  @ApiProperty({ example: 30 })
  @IsInt()
  @Min(0)
  @ApiProperty({ example: 30 })
  @IsInt()
  @Max(2_147_483_647)
  noticePeriodDays!: number;
}

export class AcceptResignationDto {
  @ApiPropertyOptional({ example: '2026-11-20' })
  @IsOptional()
  @IsDateString()
  agreedLastWorkingDay?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  noticeWaiverDays?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(2_000)
  waiverReason?: string;
}

export class WithdrawResignationDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(2_000)
  reason!: string;
}
