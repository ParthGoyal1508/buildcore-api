import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
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
  signatoryId?: string;
}
