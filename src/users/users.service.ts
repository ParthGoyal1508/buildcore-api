import { PrismaService } from 'nestjs-prisma';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { AccessLevel, Permission, Prisma, UserStatus } from '@prisma/client';
import type { Grant } from '../auth/authenticated-user';
import { roleGrants } from '../settings/roles/grant-ceiling';
import { PasswordService } from '../auth/password.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  RlsContext,
  rlsContextFor,
  withRlsContext,
} from '../common/prisma/rls-context';
import { UserSummary, displayNameOf, toUserSummary } from './user-summary';

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
      grants: caller.grants,
      roleNames: caller.roleNames,
      roleIds: caller.roleIds,
      homeModule: caller.homeModule,
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
  /**
   * What a role grants, as area-and-level pairs, or null when there is no such role — the
   * ceiling check on assigning it (2026-10-16 audit, C1). `Role` is global and carries no
   * row-level security, so the context is immaterial.
   */
  async grantsOfRole(roleId: string): Promise<Grant[] | null> {
    return roleGrants(this.prisma, roleId);
  }

  /**
   * Accounts holding `roleId` outside `companyId` — including cross-company accounts, which
   * belong to none. Roles are global, so this is what decides whether a company administrator's
   * edit would reach other companies (2026-10-16 audit, C3).
   */
  async countRoleHoldersOutside(
    roleId: string,
    companyId: string | null,
  ): Promise<number> {
    return withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.userRole.count({
        where: {
          roleId,
          OR: [{ companyId: null }, { companyId: { not: companyId ?? '' } }],
        },
      }),
    );
  }

  /**
   * Active accounts per role within the caller's scope (036 C11) — what the approval settings
   * screen shows beside a level, since a level mapped to a role nobody here holds stalls every item
   * that reaches it.
   */
  async activeHolderCounts(ctx: RlsContext): Promise<Map<string, number>> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.userRole.groupBy({
        by: ['roleId'],
        where: {
          user: {
            status: UserStatus.active,
            ...(ctx.isSuperAdmin ? {} : { companyId: ctx.companyId ?? null }),
          },
        },
        _count: { _all: true },
      }),
    );
    return new Map(rows.map((r) => [r.roleId, r._count._all]));
  }

  async countByRoleId(roleId: string): Promise<number> {
    return withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.userRole.count({ where: { roleId } }),
    );
  }

  /**
   * Active accounts holding `roleId` in `companyId`, with their display names.
   *
   * Added for feature 016's approval spine, which needs to say *who* an item is waiting
   * on. A level resolves to a role, and turning that into people means reading
   * `settings.UserRole` — which the spine's `shared` tables may not do directly
   * (Principle I). So it lives here, on the module that owns `shared.User` and already
   * owns every other user-to-role question (`countByRoleId` above,
   * `clearRoleAssignment` below).
   *
   * Runs as system/bypass because it is called while answering "who must approve this",
   * a question about a company the caller is already scoped to; the `companyId` filter
   * is explicit rather than inherited from the RLS context so the method cannot
   * accidentally return holders from every company.
   */
  async findActiveHoldersOfRole(
    roleId: string,
    companyId: string,
  ): Promise<{ id: string; name: string }[]> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findMany({
          where: {
            companyId,
            status: 'active',
            userRoles: { some: { roleId } },
          },
          select: {
            id: true,
            displayName: true,
            firstname: true,
            lastname: true,
            username: true,
            email: true,
          },
          orderBy: { createdAt: 'asc' },
        }),
    );
    return rows.map((u) => ({ id: u.id, name: displayNameOf(u) }));
  }

  /**
   * Active accounts in `companyId` whose roles grant `permission` at write level, with their
   * display names.
   *
   * Added for 031's supervisor site assignment: HR picks from the people who can actually mark
   * labour attendance, and only `UserRole` says who that is. Write level because read-only access
   * to the labour register cannot punch anyone. The legacy `Role.permissions` array is consulted
   * too, the same fallback the guard keeps while that column is retired.
   */
  async findActiveHoldersOfPermission(
    permission: Permission,
    companyId: string,
  ): Promise<{ id: string; name: string }[]> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findMany({
          where: {
            companyId,
            status: 'active',
            userRoles: {
              some: {
                role: {
                  OR: [
                    {
                      rolePermissions: {
                        some: { permission, level: AccessLevel.write },
                      },
                    },
                    { permissions: { has: permission } },
                  ],
                },
              },
            },
          },
          select: {
            id: true,
            displayName: true,
            firstname: true,
            lastname: true,
            username: true,
            email: true,
          },
          orderBy: { createdAt: 'asc' },
        }),
    );
    return rows.map((u) => ({ id: u.id, name: displayNameOf(u) }));
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
    return (await this.listForCompany(ctx)).items;
  }

  /**
   * The Users list with search, filters, sort and an optional page (036 C5). Without `take` it is
   * every matching account, which is what `findAllForCompany` has always returned.
   *
   * `companyId` only narrows: a company-scoped caller's `where` is already their company, and an
   * AND of the two cannot widen it.
   */
  async listForCompany(
    ctx: RlsContext,
    filters: {
      q?: string;
      status?: UserStatus;
      roleId?: string;
      companyId?: string;
      sort?: { key: 'name' | 'email' | 'status' | 'lastLoginAt' | 'createdAt'; dir: 'asc' | 'desc' };
      skip?: number;
      take?: number;
    } = {},
  ): Promise<{ items: UserSummary[]; total: number }> {
    const q = filters.q?.trim();
    const where: Prisma.UserWhereInput = {
      AND: [
        ctx.isSuperAdmin ? {} : { companyId: ctx.companyId ?? null },
        filters.companyId ? { companyId: filters.companyId } : {},
        filters.status ? { status: filters.status } : {},
        filters.roleId ? { userRoles: { some: { roleId: filters.roleId } } } : {},
        q
          ? {
              OR: [
                { displayName: { contains: q, mode: 'insensitive' } },
                { firstname: { contains: q, mode: 'insensitive' } },
                { lastname: { contains: q, mode: 'insensitive' } },
                { username: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    const dir = filters.sort?.dir ?? 'asc';
    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      filters.sort?.key === 'name'
        ? [
            { displayName: { sort: dir, nulls: 'last' } },
            { firstname: { sort: dir, nulls: 'last' } },
            { username: dir },
          ]
        : filters.sort?.key === 'lastLoginAt'
        ? [{ lastLoginAt: { sort: dir, nulls: 'last' } }]
        : filters.sort?.key
        ? [{ [filters.sort.key]: dir }]
        : [{ createdAt: 'asc' }];
    const [users, total] = await withRlsContext(this.prisma, ctx, (tx) =>
      Promise.all([
        tx.user.findMany({
          where,
          include: { userRoles: { include: { role: true } } },
          // `id` last so equal sort values page stably.
          orderBy: [...orderBy, { id: 'asc' }],
          skip: filters.skip,
          take: filters.take,
        }),
        filters.take === undefined
          ? Promise.resolve(-1)
          : tx.user.count({ where }),
      ]),
    );
    return {
      items: users.map(toUserSummary),
      total: total < 0 ? users.length : total,
    };
  }

  /** An account's current status and address, or null when the caller cannot see it — what
   * `UsersAdminService` needs to tell a real deactivation from a repeated one (029 FR-030). */
  async accountStatus(
    id: string,
    ctx: RlsContext,
  ): Promise<{ status: UserStatus; email: string } | null> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.user.findUnique({
        where: { id },
        select: { status: true, email: true },
      }),
    );
  }

  /**
   * Replaces an account's role assignment and/or flips its status (002 FR-014).
   *
   * `roleIds` is the account's complete role set after the save (036 C1). Only the
   * difference is written: roles no longer listed are removed, new ones added, and a
   * role held and still listed is left alone — its `UserRole` row (and `createdAt`)
   * survives. The old singular `roleId` reaches here as a one-element set, which is the
   * "make this the account's only role" meaning it always had.
   *
   * The last-active-Super-Admin guard is NOT applied here; it belongs to the
   * caller (`UsersAdminService`), which owns that policy (research.md §5).
   */
  async updateRoleOrStatus(
    id: string,
    changes: { roleIds?: string[]; status?: UserStatus },
    ctx: RlsContext,
  ): Promise<UserSummary> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id },
        select: { id: true, companyId: true, status: true },
      });
      if (!existing) {
        throw new NotFoundException(`User ${id} not found`);
      }

      // FR-008 (010-account-creation-backend). Activating an account means proving
      // control of its inbox and choosing a password; writing `active` directly
      // would produce an account marked usable whose password column is still null,
      // which login then has to treat as an invalid credential forever. The guard
      // lives on the service rather than in a controller so it holds for every
      // caller — 002's PATCH /settings/users/:id is the entry point that reaches it
      // today.
      if (
        changes.status === UserStatus.active &&
        existing.status === UserStatus.pending
      ) {
        throw new BadRequestException(
          'That account has not accepted its invite yet, so it cannot be activated directly. Resend the invite instead.',
        );
      }

      if (changes.roleIds && changes.roleIds.length > 0) {
        const wanted = [...new Set(changes.roleIds)];
        const found = await tx.role.findMany({
          where: { id: { in: wanted } },
          select: { id: true, name: true, companyId: true },
        });
        const missing = wanted.filter((r) => !found.some((f) => f.id === r));
        if (missing.length > 0) {
          throw new BadRequestException(
            `Role ${missing.join(', ')} does not exist`,
          );
        }
        // A company's own role is held only in that company (036 C10).
        const foreign = found.filter(
          (r) => r.companyId !== null && r.companyId !== existing.companyId,
        );
        if (foreign.length > 0) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'ROLE_OF_ANOTHER_COMPANY',
            message: `${foreign
              .map((r) => r.name)
              .join(', ')} belongs to another company and cannot be given to this account.`,
          });
        }
        const held = (
          await tx.userRole.findMany({
            where: { userId: id },
            select: { roleId: true },
          })
        ).map((r) => r.roleId);
        const removed = held.filter((r) => !wanted.includes(r));
        const added = wanted.filter((r) => !held.includes(r));
        if (removed.length > 0) {
          await tx.userRole.deleteMany({
            where: { userId: id, roleId: { in: removed } },
          });
        }
        if (added.length > 0) {
          await tx.userRole.createMany({
            data: added.map((roleId) => ({
              userId: id,
              roleId,
              // Denormalized from the account at assignment time, matching the
              // pattern every other tenant-scoped row uses.
              companyId: existing.companyId,
            })),
          });
        }
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

  /** The ids of the roles an account holds now — what a role-set save is diffed against
   * (036 C1). Read across companies: the guard runs before the write, under the caller's
   * own checks. */
  async roleIdsOf(id: string): Promise<string[]> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.userRole.findMany({ where: { userId: id }, select: { roleId: true } }),
    );
    return rows.map((r) => r.roleId);
  }

  /** Which of `roleIds` are protected (Super Admin) roles (036 C1). `Role` is global. */
  async protectedRoleIds(roleIds: string[]): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const rows = await this.prisma.role.findMany({
      where: { id: { in: roleIds }, isProtected: true },
      select: { id: true },
    });
    return rows.map((r) => r.id);
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
