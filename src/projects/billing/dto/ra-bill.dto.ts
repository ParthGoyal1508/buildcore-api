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

  @ApiProperty({ example: 'SC-01' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  billNumber: string;

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

  @ApiProperty({
    description:
      'Why the quantities changed. **Required**: a certified bill going round again costs somebody a ' +
      'second decision, and “why” is the first thing they will ask.',
    example:
      'Re-measured after joint survey on 3 Oct; excavation 40 Cum not 48.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

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
