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
