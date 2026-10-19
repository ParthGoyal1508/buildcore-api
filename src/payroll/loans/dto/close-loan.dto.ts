import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body of `PATCH /hr/loans/:id/close` (036 B11). Replaces `@Body('reason')`, which skipped
 * validation entirely. Optional, as it always was: the service treats a missing or empty reason as
 * "no reason given" and leaves the loan's remarks alone.
 */
export class CloseLoanDto {
  @ApiPropertyOptional({
    description: 'Why the loan was closed early. Appended to the remarks.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
