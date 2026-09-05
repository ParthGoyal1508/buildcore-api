import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResignationReasonCategory, ResignationStatus } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class ListResignationsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() companyId?: string;
  @ApiPropertyOptional({ enum: ResignationStatus })
  @IsOptional()
  @IsEnum(ResignationStatus)
  status?: ResignationStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() employeeId?: string;
}

export class CreateResignationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() companyId?: string;
  @ApiProperty() @IsString() @IsNotEmpty() employeeId!: string;
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
  @ApiProperty({ example: 30 }) @IsInt() @Min(0) noticePeriodDays!: number;
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
  noticeWaiverDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() waiverReason?: string;
}

export class WithdrawResignationDto {
  @ApiProperty() @IsString() @IsNotEmpty() reason!: string;
}
