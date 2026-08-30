import { PrismaService } from 'nestjs-prisma';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { PasswordService } from '../auth/password.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  RlsContext,
  rlsContextFor,
  withRlsContext,
} from '../common/prisma/rls-context';
import { UserSummary, toUserSummary } from './user-summary';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private passwordService: PasswordService,
  ) {}

  async updateUser(
    caller: AuthenticatedUser,
    newUserData: UpdateUserDto,
  ): Promise<AuthenticatedUser> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.user.update({
          data: newUserData,
          where: {
            id: caller.id,
          },
        }),
    );
    // Neither field this endpoint can change (firstname/lastname) affects roles.
    return {
      ...updated,
      permissions: caller.permissions,
      roleNames: caller.roleNames,
    };
  }

  async changePassword(
    caller: AuthenticatedUser,
    changePassword: ChangePasswordDto,
  ): Promise<AuthenticatedUser> {
    const passwordValid = await this.passwordService.validatePassword(
      changePassword.oldPassword,
      caller.password,
    );

    if (!passwordValid) {
      throw new BadRequestException('Invalid password');
    }

    const hashedPassword = await this.passwordService.hashPassword(
      changePassword.newPassword,
    );

    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.user.update({
          data: {
            password: hashedPassword,
          },
          where: { id: caller.id },
        }),
    );
    return {
      ...updated,
      permissions: caller.permissions,
      roleNames: caller.roleNames,
    };
  }

  // ---------------------------------------------------------------------------
  // Administration surface, consumed by SettingsModule's user-administration and
  // roles endpoints (002 US2/US3).
  //
  // These live here, on the UsersModule feature 001 already shipped, rather than in
  // SettingsModule: `shared.User` belongs to this module, and Principle I forbids
  // `settings` from querying another schema's tables directly — cross-module reads
  // go through an exported service method. 002's tasks.md assigns them to a future
  // `AccountCreationModule` (feature 010); when 010 lands it can take ownership of
  // these and re-export them without changing a single caller.
  // ---------------------------------------------------------------------------

  /** How many accounts currently hold `roleId` — powers the Roles list's
   * assignedUserCount (002 FR-009). */
  async countByRoleId(roleId: string): Promise<number> {
    return withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.userRole.count({ where: { roleId } }),
    );
  }

  /** Removes every assignment of `roleId`, leaving affected accounts with no module
   * access until reassigned (002 FR-010). Called when a role is deleted; with the
   * many-to-many model this drops only the deleted role's assignments and leaves any
   * other roles those accounts hold intact. */
  async clearRoleAssignment(roleId: string): Promise<number> {
    const { count } = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) => tx.userRole.deleteMany({ where: { roleId } }),
    );
    return count;
  }

  /** Accounts visible to the caller — their own company, or every company for a
   * caller holding CROSS_COMPANY_ACCESS (002 FR-013). RLS on `UserRole` does the
   * scoping; `shared.User` rows are filtered to match. */
  async findAllForCompany(ctx: RlsContext): Promise<UserSummary[]> {
    const users = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.user.findMany({
        where: ctx.isSuperAdmin ? {} : { companyId: ctx.companyId ?? null },
        include: { userRoles: { include: { role: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return users.map(toUserSummary);
  }

  /**
   * Replaces an account's role assignment and/or flips its status (002 FR-014).
   *
   * `roleId` is singular by contract — the Users form offers one Role dropdown — so
   * under the many-to-many model it means "make this the account's only role",
   * replacing whatever set it held. Callers needing additive assignment should not
   * use this method.
   *
   * The last-active-Super-Admin guard is NOT applied here; it belongs to the
   * caller (`UsersAdminService`), which owns that policy (research.md §5).
   */
  async updateRoleOrStatus(
    id: string,
    changes: { roleId?: string; status?: UserStatus },
    ctx: RlsContext,
  ): Promise<UserSummary> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id },
        select: { id: true, companyId: true },
      });
      if (!existing) {
        throw new NotFoundException(`User ${id} not found`);
      }

      if (changes.roleId) {
        const role = await tx.role.findUnique({
          where: { id: changes.roleId },
          select: { id: true },
        });
        if (!role) {
          throw new BadRequestException(
            `Role ${changes.roleId} does not exist`,
          );
        }
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.create({
          data: {
            userId: id,
            roleId: changes.roleId,
            // Denormalized from the account at assignment time, matching the
            // pattern every other tenant-scoped row uses.
            companyId: existing.companyId,
          },
        });
      }

      if (changes.status) {
        await tx.user.update({
          where: { id },
          data: { status: changes.status },
        });
      }

      const updated = await tx.user.findUniqueOrThrow({
        where: { id },
        include: { userRoles: { include: { role: true } } },
      });
      return toUserSummary(updated);
    });
  }

  /** Hard-deletes an account and everything that references it, so it can no longer
   * authenticate (002 FR-015). */
  async deleteAccount(id: string, ctx: RlsContext): Promise<void> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException(`User ${id} not found`);
      }
      // FK-dependent rows first — refresh tokens and audit entries both reference
      // the account, and would otherwise block the delete.
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.refreshToken.deleteMany({ where: { accountId: id } });
      await tx.auditLogEntry.updateMany({
        where: { accountId: id },
        // The audit trail outlives the account it describes — detach rather than
        // delete, so a deleted admin's actions remain on record.
        data: { accountId: null },
      });
      await tx.user.delete({ where: { id } });
    });
  }

  /**
   * Active accounts holding a protected (Super Admin) role — the count
   * `UsersAdminService` checks before allowing a deactivation, deletion, or role
   * reassignment that could leave the system with no way back in (002 FR-016,
   * research.md §5).
   */
  async countActiveSuperAdmins(): Promise<number> {
    return withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.user.count({
        where: {
          status: UserStatus.active,
          userRoles: { some: { role: { isProtected: true } } },
        },
      }),
    );
  }

  /** Whether this account is one of the protected-role holders — used alongside
   * `countActiveSuperAdmins()` to tell "the last one" from "one of several". */
  async holdsProtectedRole(id: string): Promise<boolean> {
    const count = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.userRole.count({
          where: { userId: id, role: { isProtected: true } },
        }),
    );
    return count > 0;
  }
}
