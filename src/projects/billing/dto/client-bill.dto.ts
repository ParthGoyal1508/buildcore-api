import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsBase64Payload } from '../../../common/uploads/base64-payload';

export class ComposeBillLineDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  boqTaskItemId: string;

  @ApiProperty({
    description:
      'Measured on **this** bill. Cumulative is an aggregate the server derives — a client sending a ' +
      'running total would be sending a second copy of a figure the server already knows.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  @Max(999_999_999_999_999)
  quantity: number;

  @ApiPropertyOptional({
    description:
      'Why this measurement goes past the BOQ scope. Required to **submit** a bill carrying an ' +
      'over-scope line, not to compose one — a measurement that cannot be entered is a measurement ' +
      'that goes in a notebook instead.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  overScopeReason?: string;
}

export class ComposeBillDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  projectId: string;

  /**
   * Omit to have it allocated: `RA-01`, `RA-02`… in sequence on this project (027).
   *
   * Was required and typed, which made the client bill number something a person invented while the
   * 023 package path was already minting one into the same column. Omission differs from an empty
   * string: `@IsOptional()` skips `undefined`, so `''` still fails `MinLength`.
   */
  @ApiPropertyOptional({ example: 'RA-01' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  billNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: '2026-08-21' })
  @IsDateString()
  billingDate: string;

  @ApiProperty({ type: [ComposeBillLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComposeBillLineDto)
  lines: ComposeBillLineDto[];

  @ApiPropertyOptional({
    description:
      'Retention withheld by the client, as a fraction — `0.05` is 5%. **Not a project cost**: it is ' +
      'the client’s money held back and released later, so the P&L reads gross rather than net.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  retentionPercent?: number;
}

/** One line's certified quantity, where the client certified line by line (2026-10-11). */
export class CertifiedLineDto {
  @ApiProperty({ description: 'The `ClientBillLine` being certified.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lineId: string;

  @ApiProperty({
    description:
      'The quantity the client accepted on this line. **Zero is meaningful** — it ' +
      'returns the whole of the billed quantity to the outstanding BOQ, which is the ' +
      'point of certifying line by line at all.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(999_999_999_999_999)
  certifiedQty: number;
}

export class CertifyBillDto {
  @ApiPropertyOptional({
    description:
      'What the client certified, as one figure. Kept **alongside** the billed amount, never ' +
      'instead of it — the variance is what a project manager chases, and overwriting erases the ' +
      'fact there was one.\n\n' +
      '**Optional since 2026-10-11, and ignored when `lines` are given**: a certified total and a ' +
      'set of certified lines that disagree is two answers to one question, and the lines are the ' +
      'ones the outstanding BOQ is counted from.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999_999)
  certifiedAmount?: number;

  @ApiPropertyOptional({
    type: [CertifiedLineDto],
    description:
      'What was certified line by line. Lines left out keep their billed quantity — omission ' +
      'is “not said”, not “certified at nothing”, and a client who returns a certificate ' +
      'covering half the schedule has said nothing about the other half.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CertifiedLineDto)
  lines?: CertifiedLineDto[];

  @ApiPropertyOptional({
    description:
      'The client’s certification document, base64-encoded — a PDF or a workbook, whatever came ' +
      'back. Replaces any copy already held: re-certifying supersedes, and the audit log records ' +
      'that it happened.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000)
  @IsBase64Payload()
  certificateData?: string;

  @ApiPropertyOptional({
    description:
      'As the uploader’s own filesystem spells it, so the download arrives named rather than as ' +
      'a bare storage reference. Required when `certificateData` is given.',
    example: 'RA-09 certification.pdf',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  certificateFileName?: string;
}
