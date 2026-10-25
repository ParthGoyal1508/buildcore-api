import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsBase64Payload } from '../../common/uploads/base64-payload';

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
  @MaxLength(200)
  letterKindKey: string;

  @ApiPropertyOptional({
    description:
      'Address the letter to an employee. Mutually exclusive with the others.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  employeeId?: string;

  @ApiPropertyOptional({ description: 'Address it to a candidate.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
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
  @MaxLength(100)
  subjectId?: string;

  /**
   * 041: the company branch whose GSTIN and address the letter prints, for a letter with no
   * project or employee to take it from (a purchase order to a vendor). Ignored when the subject
   * is a project or the letter is about an employee — theirs is used. Omitted → head office.
   */
  @ApiPropertyOptional({
    description:
      'Company branch to issue from when the letter has no project or employee; defaults to the head office',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  branchId?: string;

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
  @MaxLength(100)
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
  @MaxLength(100)
  signatoryId?: string;
}

/** The executed copy that comes back signed by the other party (FR-017). */
export class CountersignedLetterDto {
  @ApiProperty({ description: 'The scanned executed copy, base64-encoded.' })
  @IsBase64Payload()
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
  @MaxLength(200)
  letterKindKey: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  candidateId?: string;

  /** A project letter's subject — its project fields pre-fill from it (2026-10-14). */
  @ApiPropertyOptional({ example: 'project' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subjectType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  subjectId?: string;

  /**
   * 041: the company branch whose GSTIN and address the letter prints, for a letter with no
   * project or employee to take it from (a purchase order to a vendor). Ignored when the subject
   * is a project or the letter is about an employee — theirs is used. Omitted → head office.
   */
  @ApiPropertyOptional({
    description:
      'Company branch to issue from when the letter has no project or employee; defaults to the head office',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  branchId?: string;
}
