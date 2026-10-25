import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Row statuses the matrix can be narrowed to (042): a row qualifies when **any** of its months
 * is in that state — the reading the screen's status filter always had. `gray` (not yet due) is
 * not a breach and not offered.
 */
export const RAG_ROW_FILTERS = [
  'verified',
  'submitted',
  'partial',
  'missing',
] as const;
export type RagRowFilter = (typeof RAG_ROW_FILTERS)[number];

export class RagMatrixQueryDto {
  @ApiProperty({ example: '2025-26' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  fy!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional({
    description:
      'Rows whose contractor name contains this, case-insensitive (042).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    enum: RAG_ROW_FILTERS,
    description: 'Rows with at least one month in this state (042).',
  })
  @IsOptional()
  @IsIn(RAG_ROW_FILTERS)
  status?: RagRowFilter;
}
