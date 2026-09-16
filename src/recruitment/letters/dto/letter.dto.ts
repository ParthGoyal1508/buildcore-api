import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateLetterTemplateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() companyId?: string;
  @ApiProperty({
    description:
      "The letter kind's key — `offer`, `appointment`, `relieving`. A plain string " +
      'since 017: kinds are rows now (FR-011), so an enum here would reject any kind ' +
      'defined after this code shipped. The five original values are unchanged.',
    example: 'appointment',
  })
  @IsString()
  @MinLength(1)
  letterType!: string;
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
  @ApiProperty({
    description:
      "The letter kind's key — `offer`, `appointment`, `relieving`. A plain string " +
      'since 017: kinds are rows now (FR-011), so an enum here would reject any kind ' +
      'defined after this code shipped. The five original values are unchanged.',
    example: 'appointment',
  })
  @IsString()
  @MinLength(1)
  letterType!: string;
  @ApiProperty() @IsString() @IsNotEmpty() employeeId!: string;
}
