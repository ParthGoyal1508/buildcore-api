import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Paging for `GET /approvals/queue` (016 FR-010, T044).
 *
 * A DTO rather than two `@Query()` parameters for the reason `ListRemindersDto` records:
 * with `transform: true`, Nest hands an absent value to class-transformer along with the
 * metatype and two feature-005 endpoints returned 500 on a missing query parameter for
 * exactly this reason.
 */
export class ApprovalQueueQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 25,
    description: 'Page size. The service clamps out-of-range values as well.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'The `nextCursor` from the previous page. Cursor paging rather than offset ' +
      'because the queue drains while it is being read — with an offset, deciding on ' +
      'the first item silently skips one on the next page.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
