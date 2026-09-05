import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class JoinDto {
  @ApiProperty({ example: '2026-11-15' })
  @IsDateString()
  actualJoiningDate!: string;
  @ApiProperty({ example: '1995-06-20' }) @IsDateString() dateOfBirth!: string;
  @ApiProperty({ enum: Gender }) @IsEnum(Gender) gender!: Gender;
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  permanentAddress!: string;
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  emergencyContact!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() siteId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() shiftId?: string;
}
