import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

import {
  SEARCH_MAX_TERM_LENGTH,
  SEARCH_MIN_TERM_LENGTH,
} from '../search.limits';

/**
 * `GET /search` query (021 FR-001, contract Part 3).
 *
 * The length bound is a **validator**, so a short term is a 400 with a message rather
 * than an empty result list. Those are different facts — "keep typing" and "nothing
 * matched" — and a client handed an empty array cannot tell them apart.
 */
export class SearchQueryDto {
  @ApiProperty({
    minLength: SEARCH_MIN_TERM_LENGTH,
    maxLength: SEARCH_MAX_TERM_LENGTH,
    description: 'The term. Matched as a code prefix and as a name substring.',
  })
  @IsString()
  @Length(SEARCH_MIN_TERM_LENGTH, SEARCH_MAX_TERM_LENGTH, {
    message:
      `Search needs at least ${SEARCH_MIN_TERM_LENGTH} characters, and at most ` +
      `${SEARCH_MAX_TERM_LENGTH}.`,
  })
  q!: string;

  @ApiPropertyOptional({
    description:
      'Which company to search, for a caller who may work across companies. ' +
      'Ignored for a company-scoped caller, whose own company always wins.',
  })
  @IsOptional()
  @IsString()
  companyId?: string;
}
