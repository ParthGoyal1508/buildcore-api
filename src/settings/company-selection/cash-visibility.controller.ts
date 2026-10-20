import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Ip,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuditAction, AuditEntityType, Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import {
  CONFIRMATION_TOKEN_HEADER,
  PasswordConfirmationService,
} from '../../auth/password-confirmation.service';
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
 *
 * ## Super Admin only, behind the caller's own password (2026-10-14)
 *
 * The client moved this out of the top bar and into Settings with: "This is a sensitive
 * permission, so it should stay hidden by default and only Super Admins should be able to reach
 * it. To reveal it, the Super Admin must enter their own password in Settings."
 *
 * So both routes now also require **`CROSS_COMPANY_ACCESS`** — which is what this codebase means
 * by Super Admin (`rlsContextFor`, `dwr.service.ts`, `users-admin.service.ts` all key the role's
 * powers to that permission, never to its renameable display name). It is checked here rather than
 * by adding it to `@RequirePermissions`, because that decorator admits a caller holding **any** of
 * the listed permissions, and this needs both.
 *
 * The **change** additionally requires a live password confirmation from
 * `POST /auth/confirm-password` in `X-Confirmation-Token`. The interface hides the switch until
 * the password is entered; this is what makes that more than a hidden switch — a session left
 * open on somebody's desk cannot flip the setting by calling the API directly. Reading the current
 * value does not need one: it tells a Super Admin nothing they could not change anyway, and the
 * interface needs it to show the state it is about to reveal.
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
    private readonly passwordConfirmation: PasswordConfirmationService,
  ) {}

  /** Super Admin is `CROSS_COMPANY_ACCESS` — see the class note. */
  private assertSuperAdmin(caller: AuthenticatedUser): void {
    if (!caller.permissions.includes(Permission.CROSS_COMPANY_ACCESS)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'SUPER_ADMIN_ONLY',
        message: 'Only a Super Admin can view or change cash visibility.',
      });
    }
  }

  @Get()
  @ApiOperation({ summary: 'Whether cash transactions are currently hidden' })
  async current(
    @UserEntity() caller: AuthenticatedUser,
    @Query('companyId') companyId?: string,
  ) {
    this.assertSuperAdmin(caller);
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
    summary: 'Hide or show cash transactions across the application',
    description:
      'Hide **and** block (038). While on, no cash transaction of the company appears ' +
      'anywhere — lists, details, totals, reports, exports, dashboard, notifications, ' +
      'activity log — and every total is computed without cash; nobody, Super Admin ' +
      'included, can record or change a cash transaction (403 `CASH_HIDDEN`). Nothing is ' +
      'deleted or altered: turning it off restores everything exactly.\n\n' +
      'Super Admin only, and only with a live confirmation from ' +
      '`POST /auth/confirm-password` (purpose `cash-visibility`) in `X-Confirmation-Token`.',
  })
  @ApiHeader({ name: 'X-Confirmation-Token', required: true })
  async update(
    @UserEntity() caller: AuthenticatedUser,
    @Body() dto: CashVisibilityDto,
    @Ip() ipAddress: string,
    @Headers(CONFIRMATION_TOKEN_HEADER) confirmationToken?: string,
    @Query('companyId') companyId?: string,
  ) {
    this.assertSuperAdmin(caller);
    this.passwordConfirmation.assertConfirmed(
      confirmationToken,
      caller.id,
      'cash-visibility',
    );
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
      changes: {
        // Named so the activity log can say what changed rather than print the company's id.
        event: 'cash_visibility_changed',
        hideCashTransactions: dto.hideCashTransactions,
        confirmedByPassword: true,
      },
      accountId: caller.id,
      companyId: resolved,
      // The caller's address, as every other entry carries. It held the route's own path until
      // 2026-10-15, which left the one sensitive change in the log with no idea where it came from.
      ipAddress,
    });

    return updated;
  }
}
