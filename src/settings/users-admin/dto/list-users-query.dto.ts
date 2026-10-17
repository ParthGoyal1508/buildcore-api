import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const USER_LIST_SORT_KEYS = [
  'name',
  'email',
  'status',
  'lastLoginAt',
  'createdAt',
] as const;
export type UserListSortKey = (typeof USER_LIST_SORT_KEYS)[number];

/**
 * Query for `GET /settings/users` (036 C5): search, filters, sort and paging.
 *
 * **Backward compatible by request shape**: with neither `page` nor `pageSize` the answer is the
 * same bare array as before (filters still apply when given); with either, it is
 * `{ items, total, page, pageSize }`. The Users screen had no search, no filter and no paging, and a
 * company whose every employee has a self-service login is a list of hundreds.
 */
export class ListUsersQueryDto {
  @ApiPropertyOptional({
    description: 'Matches name, username or email (case-insensitive).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: UserStatus })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ description: 'Accounts holding this role.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  roleId?: string;

  @ApiPropertyOptional({
    description:
      'Home company. Only narrows what the caller may already see; ignored outside it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @ApiPropertyOptional({
    description: `\`key:asc\` or \`key:desc\`; key one of ${USER_LIST_SORT_KEYS.join(
      ', ',
    )}. Default \`createdAt:asc\`.`,
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  sort?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/** `sort` parsed, or the default; an unknown key falls back rather than failing the list. */
export function parseUserSort(sort: string | undefined): {
  key: UserListSortKey;
  dir: 'asc' | 'desc';
} {
  const match = sort ? /^(\w+):(asc|desc)$/.exec(sort) : null;
  if (match && (USER_LIST_SORT_KEYS as readonly string[]).includes(match[1])) {
    return { key: match[1] as UserListSortKey, dir: match[2] as 'asc' | 'desc' };
  }
  return { key: 'createdAt', dir: 'asc' };
}
