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
import { assertMayGrant } from '../roles/grant-ceiling';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { effectiveCompanyId } from '../company-scope';
import { UserSummary } from '../../users/user-summary';
import { UsersService } from '../../users/users.service';
import { AccountDeactivationService } from '../../users/account-deactivation.service';
import { UpdateUserAccountDto } from './dto/update-user.dto';
import { ListUsersQueryDto, parseUserSort } from './dto/list-users-query.dto';

/** One page of accounts (036 C5) — the shape the other paged lists answer with. */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

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
    private readonly deactivation: AccountDeactivationService,
  ) {}

  /** Accounts in the caller's company, or all of them for a cross-company caller
   * (FR-013). */
  async findAll(
    caller: AuthenticatedUser,
    query: ListUsersQueryDto = {},
  ): Promise<UserSummary[] | Paged<UserSummary>> {
    this.assertMayAdminister(caller);
    // 036 C5: a page only when one is asked for, so an unchanged client still gets its array.
    const paged = query.page !== undefined || query.pageSize !== undefined;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const { items, total } = await this.usersService.listForCompany(
      rlsContextFor(caller),
      {
        q: query.q,
        status: query.status,
        roleId: query.roleId,
        companyId: query.companyId,
        sort: parseUserSort(query.sort),
        ...(paged ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
      },
    );
    return paged ? { items, total, page, pageSize } : items;
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateUserAccountDto,
    ipAddress: string,
  ): Promise<UserSummary> {
    this.assertMayAdminister(caller);
    await this.assertMayActOn(caller, id, {
      removesAccess: dto.status === UserStatus.deactivated,
    });

    // 036 C1: the role set after the save. `roleIds` is the whole set; the older singular
    // `roleId` means "this one role only", so it is the same request with one element.
    const wanted =
      dto.roleIds ?? (dto.roleId !== undefined ? [dto.roleId] : undefined);
    let added: string[] = [];
    let removed: string[] = [];
    if (wanted !== undefined) {
      const held = await this.usersService.roleIdsOf(id);
      added = wanted.filter((r) => !held.includes(r));
      removed = held.filter((r) => !wanted.includes(r));
    }
    const rolesChange = added.length > 0 || removed.length > 0;

    if (rolesChange) {
      // 2026-10-16 audit, C1. Before this, any USER_MANAGEMENT holder could give any account —
      // their own included — the protected Super Admin role, and with it every company.
      if (id === caller.id) {
        throw new ForbiddenException({
          code: 'OWN_ROLE_CHANGE',
          message:
            'You cannot change your own role. Ask another administrator to do it.',
        });
      }
      // Only what is *added* is checked against the caller's ceiling (036 C1): a role the account
      // already holds is not being granted by this save, and re-checking it would stop a company
      // administrator from adding a small role to an account that also holds a wide one.
      for (const roleId of added) {
        const grants = await this.usersService.grantsOfRole(roleId);
        if (grants === null) {
          throw new ConflictException(`Role ${roleId} does not exist`);
        }
        assertMayGrant(caller, grants, 'assign that role');
      }
    }

    // Deactivating the last Super Admin, or taking its protected role away, would leave
    // nobody able to administer the system (FR-016). Both are the same failure, so both
    // are checked here rather than only on the deactivate path. A role change that keeps a
    // protected role in the set (adding a second role to a Super Admin) loses nothing.
    const losesProtectedRole =
      rolesChange &&
      (await this.usersService.protectedRoleIds(removed)).length > 0 &&
      (await this.usersService.protectedRoleIds(wanted ?? [])).length === 0;
    if (dto.status === UserStatus.deactivated || losesProtectedRole) {
      await this.assertNotLastSuperAdmin(id);
    }

    // Read first, so only a real transition to deactivated revokes sessions and emails — saving
    // an already-deactivated account again must not send the notice twice (029 FR-030).
    const before =
      dto.status === UserStatus.deactivated
        ? await this.usersService.accountStatus(id, rlsContextFor(caller))
        : null;

    const updated = await this.usersService.updateRoleOrStatus(
      id,
      { roleIds: rolesChange ? wanted : undefined, status: dto.status },
      rlsContextFor(caller),
    );

    if (before && before.status !== UserStatus.deactivated) {
      await this.deactivation.afterDeactivation({ id, email: before.email });
    }

    await this.auditLog.record({
      // Shared with feature 010 so both features' writes to an account appear under
      // one entity type in the Activity Log.
      entityType: AuditEntityType.USER_ACCOUNT,
      action: AuditAction.UPDATE,
      entityId: id,
      // The two sides of a role change named explicitly (036 C1), so the log says which role
      // was taken away rather than only the set that was left.
      changes: {
        requested: { ...dto },
        ...(rolesChange ? { rolesAdded: added, rolesRemoved: removed } : {}),
      },
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
    await this.assertMayActOn(caller, id, { removesAccess: true });
    await this.assertNotLastSuperAdmin(id);

    await this.usersService.deleteAccount(id, rlsContextFor(caller));

    await this.auditLog.record({
      entityType: AuditEntityType.USER_ACCOUNT,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: effectiveCompanyId(caller),
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

  /**
   * Who an administrator may act on (036 C3).
   *
   * - **Not themselves, to remove their own access.** Deleting or deactivating your own account
   *   locks you out mid-session and, for the only administrator of a company, locks the company
   *   out of its own user management. Another administrator does it.
   * - **A holder of a protected role (Super Admin) only with cross-company access.** A company
   *   administrator could delete or deactivate a Super Admin who happened to be homed in their
   *   company — removing an account whose authority is wider than their own.
   */
  private async assertMayActOn(
    caller: AuthenticatedUser,
    id: string,
    action: { removesAccess: boolean },
  ): Promise<void> {
    if (action.removesAccess && id === caller.id) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'OWN_ACCOUNT',
        message:
          'You cannot delete or deactivate your own account. Ask another administrator to do it.',
      });
    }
    if (
      !caller.permissions.includes(Permission.CROSS_COMPANY_ACCESS) &&
      (await this.usersService.holdsProtectedRole(id))
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PROTECTED_ACCOUNT',
        message:
          'This account holds a group-wide role. Only a group administrator can change or remove it.',
      });
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
