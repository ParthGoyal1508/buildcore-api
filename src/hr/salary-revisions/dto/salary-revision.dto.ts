import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Recording a salary revision (an increment, or any change to the pay heads).
 *
 * Every head is optional: an omitted head keeps the employee's current value, so an increment
 * that only moves `basic` is sent as `{ effectiveFrom, basic }`. The head names match the
 * employee form's, except `conveyance`, which is `conveyanceAllowance` on the employee — the
 * revision table was named for the letter, not the form.
 *
 * Appends. There is no update DTO: a revision issued in a letter has to stay what the letter said.
 */
export class CreateSalaryRevisionDto {
  @ApiProperty({
    description:
      'The day the new pay takes effect, `YYYY-MM-DD`. Must be today or earlier — the heads are ' +
      'written onto the employee immediately, so HR records a revision on or after its date.',
    example: '2026-10-01',
  })
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'effectiveFrom must be a date in the form YYYY-MM-DD',
  })
  effectiveFrom: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999.99)
  basic?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999.99)
  hra?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999.99)
  conveyance?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999.99)
  siteAllowance?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999.99)
  specialAllowance?: number;

  @ApiPropertyOptional({
    description: 'Why the pay changed, e.g. "Annual increment 2026".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;
}
