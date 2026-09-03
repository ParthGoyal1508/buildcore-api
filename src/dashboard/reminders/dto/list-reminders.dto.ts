import { ApiPropertyOptional } from '@nestjs/swagger';
import { ReminderSeverity } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString } from 'class-validator';

/**
 * Scope selector from spec US9 acceptance scenario 2's
 * `?type=&severity=&module=&scope=`.
 *
 * `company` (the default) is the caller's own company. `all` spans every tenant and
 * is refused with 403 for anyone without `CROSS_COMPANY_ACCESS` — FR-035's rule,
 * enforced rather than silently downgraded, so a caller who asks for something they
 * may not have is told, instead of quietly receiving less than they asked for and
 * drawing the wrong conclusion from it.
 */
export type ReminderScope = 'company' | 'all';

/**
 * Query parameters for the reminders list.
 *
 * A DTO class rather than individual `@Query('severity')` parameters, for the reason
 * `ListClientsDto` records: with `transform: true`, Nest hands an absent value to
 * class-transformer along with the enum as its metatype and class-transformer
 * dereferences it — two 005 endpoints returned 500 on a missing query parameter for
 * exactly this reason.
 */
export class ListRemindersDto {
  @ApiPropertyOptional({
    description:
      'Reminder family, e.g. `document_expiry`. Omit for every type.',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({
    enum: ReminderSeverity,
    description: 'Omit to see every band',
  })
  @IsOptional()
  @IsEnum(ReminderSeverity)
  severity?: ReminderSeverity;

  @ApiPropertyOptional({
    description: 'Source module, e.g. `machinery`. Omit for every module.',
  })
  @IsOptional()
  @IsString()
  module?: string;

  @ApiPropertyOptional({
    enum: ['company', 'all'],
    default: 'company',
    description: '`all` requires CROSS_COMPANY_ACCESS',
  })
  @IsOptional()
  @IsIn(['company', 'all'])
  scope?: ReminderScope;

  @ApiPropertyOptional({
    description: 'Narrow to one company. Cross-company callers only.',
  })
  @IsOptional()
  @IsString()
  companyId?: string;
}
