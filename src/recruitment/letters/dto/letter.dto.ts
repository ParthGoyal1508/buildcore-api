import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LetterType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateLetterTemplateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() companyId?: string;
  @ApiProperty({ enum: LetterType })
  @IsEnum(LetterType)
  letterType!: LetterType;
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiProperty({ description: 'Body with {{token}} substitutions' })
  @IsString()
  @IsNotEmpty()
  bodyTemplate!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() letterheadAssetId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateLetterTemplateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bodyTemplate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() letterheadAssetId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class GenerateLetterDto {
  @ApiProperty({ enum: LetterType })
  @IsEnum(LetterType)
  letterType!: LetterType;
  @ApiProperty() @IsString() @IsNotEmpty() employeeId!: string;
}
