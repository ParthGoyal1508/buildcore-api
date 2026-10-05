import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * The statutory rates a running-account bill is computed at (025 FR-021, FR-022).
 *
 * ## Why these are settable at all
 *
 * They carry correct defaults — 9%, 9%, 18%, 2% — so nothing is wrong today. But CGST is statute
 * and TDS is statute, and a statute that changes on a Monday cannot wait for a developer with
 * database access. This is the constitution's no-hardcoded-values principle reaching the one place
 * it had not: a column with a right answer and no way to change it is a hardcoded value wearing a
 * column's clothes.
 *
 * ## Fractions, bounded at one
 *
 * `0.09` is nine per cent. **`9` is refused**, which is the whole reason for the bound: a rate
 * entered as a percentage into a fraction column multiplies every tax on every bill by a hundred,
 * and the resulting figure is large enough that somebody would notice — but only after it had been
 * on a document sent to a client.
 *
 * Each field is optional so one rate can be changed without restating the other three, and an
 * omitted field leaves its rate alone.
 *
 * ## What this does not touch
 *
 * **A bill that has been issued.** Issue freezes its rates onto the package precisely so a document
 * already sent reproduces identically; this changes what is composed afterwards, and nothing else.
 */
export class SetBillingRatesDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 1, example: 0.09 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  cgstFraction?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1, example: 0.09 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  sgstFraction?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1, example: 0.18 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  igstFraction?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1, example: 0.02 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  tdsFraction?: number;
}
