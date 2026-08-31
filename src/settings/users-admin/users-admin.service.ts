import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Permission,
  UserStatus,
} from '@prisma/client';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { UserSummary } from '../../users/user-summary';
import { UsersService } from '../../users/users.service';
import { UpdateUserAccountDto } from './dto/update-user.dto';

/**
 * Account administration is gated on the USER_MANAGEMENT permission, checked here
 * server-side as well as by the controller's guard (FR-014, amended 2026-08-31).
 *
 * This replaced a check against the role *names* "Super Admin" and "HO User", which
 * had three problems. `HO User` is not a protected role, so 002's own role editor
 * could rename it — silently removing account administration from everyone holding
 * it, with identical permissions and no error anywhere. A role created through this
 * same feature and granted USER_MANAGEMENT passed the controller guard and was then
 * refused by this service, so the two gates disagreed. And it contradicted the
 * 2026-08-28 redesign that replaced the hardcoded `role === SUPER_ADMIN` check with
 * the CROSS_COMPANY_ACCESS permission for exactly this reason: roles are data an
 * administrator edits, so a capability must not be keyed to a display string.
 */
const ACCOUNT_ADMIN_PERMISSION = Permission.USER_MANAGEMENT;

@Injectable()
export class UsersAdminService {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Accounts in the caller's company, or all of them for a cross-company caller
   * (FR-013). */
  async findAll(caller: AuthenticatedUser): Promise<UserSummary[]> {
    this.assertMayAdminister(caller);
    return this.usersService.findAllForCompany(rlsContextFor(caller));
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateUserAccountDto,
    ipAddress: string,
  ): Promise<UserSummary> {
    this.assertMayAdminister(caller);

    // Deactivating the last Super Admin, or moving its role elsewhere, would leave
    // nobody able to administer the system (FR-016). Both are the same failure, so
    // both are checked here rather than only on the deactivate path.
    const losesSuperAdmin =
      dto.status === UserStatus.deactivated || dto.roleId !== undefined;
    if (losesSuperAdmin) {
      await this.assertNotLastSuperAdmin(id);
    }

    const updated = await this.usersService.updateRoleOrStatus(
      id,
      { roleId: dto.roleId, status: dto.status },
      rlsContextFor(caller),
    );

    await this.auditLog.record({
      // Shared with feature 010 so both features' writes to an account appear under
      // one entity type in the Activity Log.
      entityType: AuditEntityType.USER_ACCOUNT,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { requested: { ...dto } },
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return updated;
  }

  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<void> {
    this.assertMayAdminister(caller);
    await this.assertNotLastSuperAdmin(id);

    await this.usersService.deleteAccount(id, rlsContextFor(caller));

    await this.auditLog.record({
      entityType: AuditEntityType.USER_ACCOUNT,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: caller.companyId,
      ipAddress,
    });
  }

  /** Rejects an operation that would take the system's last active Super Admin
   * account out of service (FR-016). Harmless for every other account. */
  private async assertNotLastSuperAdmin(id: string): Promise<void> {
    if (!(await this.usersService.holdsProtectedRole(id))) {
      return;
    }
    const activeSuperAdmins = await this.usersService.countActiveSuperAdmins();
    if (activeSuperAdmins <= 1) {
      throw new ConflictException(
        'This is the last active Super Admin account; it cannot be deactivated, deleted, or reassigned',
      );
    }
  }

  private assertMayAdminister(caller: AuthenticatedUser): void {
    // `permissions` is the union across every role the caller holds
    // (authenticated-user.ts), so this admits any role granted the capability
    // rather than a fixed pair of names.
    if (!caller.permissions.includes(ACCOUNT_ADMIN_PERMISSION)) {
      throw new ForbiddenException(
        'Administering user accounts requires the User Management permission',
      );
    }
  }
}
