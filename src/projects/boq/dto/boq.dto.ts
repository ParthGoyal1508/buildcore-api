import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/**
 * **The programme fields are optional, and that is the amendment** (008 FR-037).
 *
 * A tender schedule of quantities carries no dates. Requiring them here would mean either refusing
 * the client's own file or inventing a programme for 231 lines, and an invented finish date makes
 * the Delayed alert report fiction. Planning is a later, separate act.
 */
export class CreateBoqGroupDto {
  @ApiProperty({ example: '1' })
  @IsString()
  @IsNotEmpty()
  boqNo!: string;

  @ApiProperty({ example: 'Earthwork' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    example: '825.729',
    description: 'Decimal as a string — never a float.',
  })
  @IsNumberString()
  scopeQty!: string;

  @ApiPropertyOptional({ description: 'Omit until the work is planned.' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Omit until the work is planned.' })
  @IsOptional()
  @IsDateString()
  finishDate?: string;
}

export class CreateBoqItemDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  groupId!: string;

  @ApiProperty({ example: '1' })
  @IsString()
  @IsNotEmpty()
  boqNo!: string;

  @ApiProperty({ example: 'Excavation in ordinary rock' })
  @IsString()
  @IsNotEmpty()
  taskName!: string;

  @ApiProperty({
    example: 'Cum',
    description:
      'Free text, stored as typed (FR-041). A unit master would reject the client’s own file, ' +
      'which spells 12 units 25 ways.',
  })
  @IsString()
  @IsNotEmpty()
  unit!: string;

  @ApiProperty({ example: '825.729' })
  @IsNumberString()
  scopeQty!: string;

  @ApiPropertyOptional({
    example: '251.00',
    description:
      'Omitted leaves the line at 0, and billing refuses a zero-rate line rather than billing ' +
      'it as free work.',
  })
  @IsOptional()
  @IsNumberString()
  rate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  finishDate?: string;

  @ApiPropertyOptional({
    description: 'Planned working days. Omit until planned.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  duration?: number;

  @ApiPropertyOptional({
    description: 'Overrides the rate needed to finish (FR-047).',
  })
  @IsOptional()
  @IsNumberString()
  perDayQty?: string;

  @ApiPropertyOptional({
    description: 'A variation rather than original scope (018 FR-015a).',
  })
  @IsOptional()
  @IsBoolean()
  isVariation?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  variationRef?: string;
}

export class ConfirmBoqImportDto {
  @ApiProperty({
    description: 'From the validation report. Confirmable once, by its author.',
  })
  @IsString()
  @IsNotEmpty()
  batchId!: string;
}

/**
 * A tender workbook on its way in.
 *
 * **Base64 in JSON rather than `multipart/form-data`**, which is what this feature's research §4
 * named in August and what the contract carried until 2026-10-03. Every other upload in this
 * product is base64 in JSON — company documents, equipment photos, purchase bills, payment
 * attachments each say so at their own DTO — because feature 015 established that the web client
 * has no `FormData` anywhere. Accepting multipart here would mean introducing a second transport
 * for one endpoint, and the web half of this amendment would have had to build it.
 *
 * The practical cost is stated rather than hidden: base64 inflates the payload by about a third,
 * so the 10MB file cap (FR-056) is checked against the *decoded* length.
 */
export class ValidateBoqImportDto {
  @ApiProperty({
    description:
      'The workbook, base64-encoded. `.xls` and `.xlsx` both accepted — the format is read from ' +
      'the content, not from any filename, because a renamed file is the common case.',
  })
  @IsBase64()
  file!: string;
}

/**
 * Planning a line that already exists (025 FR-009 to FR-015).
 *
 * ## Why this DTO is four fields and not fourteen
 *
 * A tender schedule carries no dates, so an imported line is unplanned and there was, until this,
 * **no update of any kind for a BOQ item**. The only route to a programme was to delete the line
 * and create it again — impossible once a daily work report had measured against it. So every
 * imported line read *Not planned* permanently, and the alert tabs, the needed-rate derivation and
 * the five-state classification that 008 built had nothing to classify.
 *
 * Scope, rate, unit, description and BOQ number are **not accepted here at all**. A programme is
 * *when* the work happens; those five are *what the work is*, and a single form that edits both is
 * how a rate gets changed while somebody is setting a date. With `forbidNonWhitelisted` on, sending
 * one is a 400 rather than a field quietly ignored — which makes FR-015 a property of this class
 * rather than a check in the service that somebody can forget to write.
 *
 * ## `null` clears, omission leaves alone (FR-011)
 *
 * The two are different intentions and must stay distinguishable, or a planner who wants to remove
 * a wrong finish date has no way to say so. `@IsOptional()` skips every other validator when the
 * value is `null` **as well as** `undefined` — usually described as a wart, and exactly the
 * behaviour wanted here. The pipe's `whitelist` keeps a declared property that arrives as `null`,
 * an absent one stays `undefined`, and the service distinguishes them with `!== undefined`.
 */
export class PlanBoqItemDto {
  @ApiPropertyOptional({
    description:
      'When the work begins. `null` clears it; omit to leave it unchanged.',
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  startDate?: string | null;

  @ApiPropertyOptional({
    description:
      'When the work must be complete. `null` clears it; omit to leave it unchanged.',
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  finishDate?: string | null;

  @ApiPropertyOptional({
    description: 'Planned working days. `null` clears it.',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  duration?: number | null;

  @ApiPropertyOptional({
    description:
      'An explicit per-day target, which overrides the rate derived from the finish date ' +
      '(FR-047). `null` clears it and returns the line to deriving.',
    nullable: true,
  })
  @IsOptional()
  @IsNumberString()
  perDayQty?: string | null;
}
