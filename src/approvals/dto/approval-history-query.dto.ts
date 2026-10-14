import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import { APPROVAL_MODULE_KEYS } from '../approval-modules';

/**
 * Which items the history lists, by where their chain stands (2026-10-15).
 *
 * - `open` — still travelling: `pending`, or `returned` to whoever raised it.
 * - `decided` — finished with a decision: `approved` or `rejected`.
 * - `withdrawn` — `abandoned`: the item left the chain without a decision (a report
 *   reverted to draft, a bill re-raised). Kept apart from `decided` because nineteen
 *   withdrawn daily reports in a "decided" list would bury the decisions.
 * - `all` — every state.
 */
export const APPROVAL_HISTORY_STATUSES = [
  'open',
  'decided',
  'withdrawn',
  'all',
] as const;
export type ApprovalHistoryStatus = (typeof APPROVAL_HISTORY_STATUSES)[number];

/**
 * Whose items: everything the caller may read (`visible`), or only the ones they took
 * part in (`mine`) — raised, were delegated, or decided.
 */
export const APPROVAL_HISTORY_SCOPES = ['visible', 'mine'] as const;
export type ApprovalHistoryScope = (typeof APPROVAL_HISTORY_SCOPES)[number];

/** Query for `GET /approvals/history`. A DTO for the reason `ApprovalQueueQueryDto` gives. */
export class ApprovalHistoryQueryDto {
  @ApiPropertyOptional({ enum: APPROVAL_HISTORY_STATUSES, default: 'decided' })
  @IsOptional()
  @IsIn(APPROVAL_HISTORY_STATUSES)
  status?: ApprovalHistoryStatus;

  @ApiPropertyOptional({ enum: APPROVAL_HISTORY_SCOPES, default: 'visible' })
  @IsOptional()
  @IsIn(APPROVAL_HISTORY_SCOPES)
  scope?: ApprovalHistoryScope;

  @ApiPropertyOptional({
    enum: APPROVAL_MODULE_KEYS,
    description: 'One module, by key. Omit for every module.',
  })
  @IsOptional()
  @IsIn(APPROVAL_MODULE_KEYS)
  module?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
