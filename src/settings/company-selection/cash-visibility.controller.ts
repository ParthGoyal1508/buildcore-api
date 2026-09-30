import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditAction, AuditEntityType, Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserEntity } from '../../common/decorators/user.decorator';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { withRlsContext } from '../../common/prisma/rls-context';
import { resolveCompanyId } from '../company-scope';
import { CashVisibilityDto } from './dto/cash-visibility.dto';

/**
 * The cash visibility toggle (019 FR-014, FR-016, FR-017) — `bugs.md` item 16.
 *
 * `COMPANY_SETTINGS`, and under feature 019's own level model that means **write** to change it
 * and **read** to see it: the verb decides, so the GET below needs only read. FR-016's "restrict
 * who can change the setting" is that permission, and its "record every change" is the existing
 * audit log, which already carries actor and time.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(Permission.COMPANY_SETTINGS)
@Controller('settings/cash-visibility')
export class CashVisibilityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Whether cash amounts are currently hidden' })
  async current(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    const resolved = resolveCompanyId(caller, companyId);
    const company = await withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId: resolved },
      (tx) =>
        tx.company.findUnique({
          where: { id: resolved },
          select: { hideCashTransactions: true },
        }),
    );
    return { hideCashTransactions: company?.hideCashTransactions ?? false };
  }

  @Patch()
  @ApiOperation({
    summary: 'Hide or show cash amounts across the application',
    description:
      'A **display** control. FR-017: nothing is deleted or altered while it is on, and ' +
      'turning it off restores every figure exactly. Amounts are returned as null with ' +
      '`amountHidden: true` beside them rather than as zero — a zero is a figure, and a ' +
      'spreadsheet summing a column cannot tell one from a hidden value.',
  })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CashVisibilityDto,
    @Query('companyId') companyId?: string,
  ) {
    const resolved = resolveCompanyId(caller, companyId);
    const updated = await withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId: resolved },
      (tx) =>
        tx.company.update({
          where: { id: resolved },
          data: { hideCashTransactions: dto.hideCashTransactions },
          select: { hideCashTransactions: true },
        }),
    );

    // FR-016's "record every change with actor and time" — the existing audit log already
    // carries both, so this adds no table.
    await this.auditLog.record({
      entityType: AuditEntityType.COMPANY,
      action: AuditAction.UPDATE,
      entityId: resolved,
      changes: { hideCashTransactions: dto.hideCashTransactions },
      accountId: caller.id,
      companyId: resolved,
      ipAddress: 'settings/cash-visibility',
    });

    return updated;
  }
}
