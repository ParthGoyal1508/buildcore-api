import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateLetterTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  companyId?: string;
  @ApiProperty({
    description:
      "The letter kind's key — `offer`, `appointment`, `relieving`. A plain string " +
      'since 017: kinds are rows now (FR-011), so an enum here would reject any kind ' +
      'defined after this code shipped. The five original values are unchanged.',
    example: 'appointment',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  letterType!: string;
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  name!: string;
  @ApiProperty({ description: 'Body with {{token}} substitutions' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  bodyTemplate!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  letterheadAssetId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateLetterTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(200)
  name?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100_000)
  bodyTemplate?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  @IsOptional()
  @MaxLength(100)
  letterheadAssetId?: string;
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
  @MaxLength(200)
  letterType!: string;
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  employeeId!: string;

  @ApiPropertyOptional({
    description:
      'Values for the letter’s fields (2026-10-14: these letters are composed by ' +
      '`/letters`). Every declared field is pre-filled from the records; send only the ' +
      '`manual` fields and corrections. A required field nobody supplies is refused with ' +
      '`LETTER_REQUIRED_FIELD_UNRESOLVED`, naming it. See `GET /letters/prefill`.',
    example: { probationMonths: '6', noticeMonths: '1' },
  })
  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Who signs, for a kind that carries a signature. Defaults to the company’s first ' +
      'active signatory; with none, the request is refused (`SIGNATORY_REQUIRED`).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  signatoryId?: string;
}

/** Optional body of `POST recruitment/offers/:id/generate` (2026-10-14). */
export class GenerateOfferLetterDto {
  @ApiPropertyOptional({
    description:
      'Values for the offer letter’s fields not held by the candidate or offer — duty ' +
      'hours (`dutyStart`, `dutyEnd`) — and any corrections. See `GET /letters/prefill`.',
    example: { dutyStart: '9:30 AM', dutyEnd: '6:30 PM' },
  })
  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Who signs the offer letter. Defaults to the company’s first active signatory.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  signatoryId?: string;
}
