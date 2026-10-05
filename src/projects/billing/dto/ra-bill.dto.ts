import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class AwardLineDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description: string;

  @ApiProperty({
    example: 'Cum',
    description:
      'Free text, deliberately. `docs/BOQ_794578.xls` carries `Cum` and `Cum.`, three spellings of ' +
      '`Sqm` and four of `R.Mtr.` within one file — a unit master would reject it.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  unit: string;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  awardedQty: number;

  @ApiProperty({
    description:
      'The **subcontractor’s** rate, not the client’s BOQ rate. The margin between the two is what the ' +
      'project P&L exists to show.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rate: number;

  @ApiPropertyOptional({
    description:
      'The client-side BOQ line this corresponds to, where it corresponds to one. **Optional**: a ' +
      'subcontract can cover work the client’s BOQ itemises differently, and requiring a match would ' +
      'make somebody invent one.',
  })
  @IsOptional()
  @IsString()
  boqTaskItemId?: string;
}

export class SetAwardDto {
  @ApiProperty({ type: [AwardLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AwardLineDto)
  lines: AwardLineDto[];
}

export class MeasureLineDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  workOrderBoqItemId: string;

  @ApiProperty({
    description: 'Measured **this period**. To-date is an aggregate.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  quantity: number;
}

export class ComposeRaBillDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  projectId: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  workOrderId: string;

  /**
   * Omit to have it allocated: `RA-01`, `RA-02`… in sequence on this work order (027).
   *
   * Was required and typed, which made this the only document in the product whose number a person
   * invents — and `RABill.billNumber` carried no unique constraint, so a number typed here could
   * silently duplicate one the 023 package path had already minted into the same column.
   *
   * Still accepted, for an importer bringing historical bills across: those numbers already exist
   * on paper, and inventing new ones would make the record disagree with the documents it
   * describes. No screen sends it.
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

  @ApiProperty({ type: [MeasureLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MeasureLineDto)
  lines: MeasureLineDto[];

  @ApiPropertyOptional({
    description:
      'Money already advanced, coming back. **Not a project cost** — counting it would count the same ' +
      'rupee twice, once when the advance went out and once here.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  advanceRecovery?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  otherDeductions?: number;
}

/**
 * A revision to a bill's measured quantities (018 FR-009).
 *
 * The whole line set, not a patch: a bill's totals and its over-measurement check are properties of
 * all its lines together, and a per-line patch would have to recompute both from a mixture of new
 * and stored values. Sending the set makes "what is this bill now" unambiguous.
 */
export class ReviseRaBillDto {
  @ApiProperty({ type: [MeasureLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MeasureLineDto)
  lines: MeasureLineDto[];

  /**
   * Why the quantities changed. **Required on a bill that has been submitted or approved, and only
   * then** — the service enforces it, because only the service knows the bill's status.
   *
   * The reason exists for the person deciding the bill a *second* time. A draft has been decided by
   * nobody: demanding a justification for editing your own unsent working document asks somebody to
   * invent one, and an invented reason devalues the field everywhere it actually matters.
   *
   * Note that omission and an empty string differ here: `@IsOptional()` skips `undefined`, so `''`
   * still fails `@MinLength(3)` rather than quietly passing as "no reason given".
   */
  @ApiPropertyOptional({
    description:
      'Why the quantities changed. Required once the bill has been submitted or approved: it going ' +
      'round again costs somebody a second decision, and “why” is the first thing they will ask.',
    example:
      'Re-measured after joint survey on 3 Oct; excavation 40 Cum not 48.',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  advanceRecovery?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  otherDeductions?: number;
}

/**
 * Recording retention going back to a subcontractor (018 FR-016a, Phase 7).
 *
 * There is no update DTO and no id to update, deliberately. A release is money leaving, and
 * correcting one by editing the row would leave no trace it had been for a different amount
 * yesterday — on the one path where the row *is* the evidence.
 */
export class ReleaseRetentionDto {
  @ApiProperty({
    description:
      'Positive, and never more than the work order still holds — the service refuses the ' +
      'latter with `RETENTION_EXCEEDS_HELD` and the column refuses the former.',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @ApiProperty({
    description:
      'The day the money went back, `YYYY-MM-DD`. Not the day somebody recorded it — a release ' +
      'entered a fortnight late still belongs on the date it happened.',
    example: '2026-10-01',
  })
  @IsDateString()
  releasedOn: string;

  @ApiProperty({
    description:
      'What this release is against. Required rather than encouraged: the first question asked ' +
      'of a release six months later is which milestone it settled, and an optional field on a ' +
      'path that moves money is an empty field.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
