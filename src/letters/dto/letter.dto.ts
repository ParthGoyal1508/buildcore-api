import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Compose a letter (017 US3).
 *
 * "Compose", not "issue". A kind that requires approval must clear its 016 chain before
 * it takes effect, and a chain has to be raised against something — so the letter exists
 * first, unissued, and is issued second. For an ungated kind the two happen in one call.
 */
export class ComposeLetterDto {
  @ApiProperty({
    description: 'The letter kind’s key — `offer`, `letter_work_order`.',
    example: 'letter_work_order',
  })
  @IsString()
  @MinLength(1)
  letterKindKey: string;

  @ApiPropertyOptional({
    description:
      'Address the letter to an employee. Mutually exclusive with the others.',
  })
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiPropertyOptional({ description: 'Address it to a candidate.' })
  @IsOptional()
  @IsString()
  candidateId?: string;

  @ApiPropertyOptional({
    description:
      'Address it to anything else — `vendor`, `project`, `purchase`. The pair is ' +
      'OPAQUE: this module stores it and never resolves it, which is what lets a letter ' +
      'address a vendor without the letters module knowing what a vendor is.',
    example: 'vendor',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  subjectType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subjectId?: string;

  @ApiPropertyOptional({
    description:
      'Template variable values, `{{token}}` → text. Optional since 2026-10-13: a ' +
      'declared field is read from the employee, candidate or company record, and a ' +
      'non-empty value here overrides it. Only `manual` fields and corrections need ' +
      'sending. See `GET /letters/prefill`.',
    example: { vendorName: 'Shree Constructions', amount: '4,50,000' },
  })
  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Required when the kind requires a signature. The graphic is frozen onto the ' +
      'letter at issue, so replacing the signatory’s image later does not rewrite it.',
  })
  @IsOptional()
  @IsString()
  signatoryId?: string;
}

/** Re-render an issued letter (FR-014) — supersede, never overwrite. */
export class ReissueLetterDto {
  @ApiPropertyOptional({
    description:
      'Values typed over the record-derived ones. Empty or absent tokens are re-read ' +
      'from the records.',
  })
  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  signatoryId?: string;
}

/** The executed copy that comes back signed by the other party (FR-017). */
export class CountersignedLetterDto {
  @ApiProperty({ description: 'The scanned executed copy, base64-encoded.' })
  @IsBase64()
  data: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @MaxLength(100)
  contentType: string;
}

/** `GET /letters/prefill` — the compose form, filled in from the records (2026-10-13). */
export class PrefillLetterQueryDto {
  @ApiProperty({ example: 'appointment' })
  @IsString()
  @MinLength(1)
  letterKindKey: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  candidateId?: string;

  /** A project letter's subject — its project fields pre-fill from it (2026-10-14). */
  @ApiPropertyOptional({ example: 'project' })
  @IsOptional()
  @IsString()
  subjectType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subjectId?: string;
}
