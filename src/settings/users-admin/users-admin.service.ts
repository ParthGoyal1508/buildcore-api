import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, UserStatus } from '@prisma/client';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { UserSummary } from '../../users/user-summary';
import { UsersService } from '../../users/users.service';
import { UpdateUserAccountDto } from './dto/update-user.dto';

/** Only these roles may administer accounts (FR-014) — enforced here, server-side,
 * in addition to the USER_MANAGEMENT permission the guard checks. */
const ACCOUNT_ADMIN_ROLES = ['Super Admin', 'HO User'];

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
    const allowed = caller.roleNames.some((name) =>
      ACCOUNT_ADMIN_ROLES.includes(name),
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Only a Super Admin or HO User may administer user accounts',
      );
    }
  }
}
