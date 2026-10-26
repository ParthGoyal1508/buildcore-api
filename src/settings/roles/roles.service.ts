import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AccessLevel,
  AuditAction,
  AuditEntityType,
  Permission,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { rlsContextFor } from '../../common/prisma/rls-context';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { UsersService } from '../../users/users.service';
import { assertMayGrant, expandRoleGrants, mayGrantAll } from './grant-ceiling';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

/** One area at one level, as the role screen reads it back. */
export type RoleGrant = { permission: Permission; level: AccessLevel };

/**
 * A role plus how many accounts currently hold it (FR-009), and the level of each area it
 * touches (019 FR-001).
 *
 * **`grants` was missing from every read until 2026-10-03**, and the consequence was quiet: the
 * write side has accepted levels since Phase 1, the guard has enforced them since, and the role
 * screen could not show them — so it sent `permissions` alone, which means read **and** write on
 * everything. A read-only role was therefore impossible to create from the portal, which is the
 * entire point of item 19's own example: site staff who may enter logbook readings and see nothing
 * else of machinery.
 *
 * Returned alongside `permissions` rather than instead of it. `Role.permissions` is on its way out
 * and is still what the rest of the codebase reads; replacing it here would break every caller for
 * the benefit of one screen.
 */
export type RoleWithAssignedCount = Role & {
  assignedUserCount: number;
  /**
   * Active accounts holding the role **in the caller's company** — the selected one, or every
   * company for a Super Admin with none selected (036 C11). `assignedUserCount` counts every
   * company, which is the right number for "who would deleting this role affect" and the wrong one
   * for "can anybody here approve at a level mapped to it". Present on the list only.
   */
  activeHolderCount?: number;
  /**
   * The owning company's name for a company role, null for a global one (036 C10). On the list
   * only, where a group administrator with no company selected sees every company's roles.
   */
  companyName?: string | null;
  grants: RoleGrant[];
};

/** A role's name is already taken where the new one would live (036 C10). */
const ROLE_NAME_TAKEN = 'ROLE_NAME_TAKEN';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * The company a caller's role reads and writes are scoped to (036 C10): their own company, or the
   * one a group administrator has selected. Null for a group administrator with none selected, who
   * sees every company's roles and creates global ones.
   */
  private scopeOf(caller: AuthenticatedUser): string | null {
    const ctx = rlsContextFor(caller);
    return ctx.isSuperAdmin ? null : ctx.companyId ?? null;
  }

  /** The roles visible in a scope: the global ones plus that company's own. */
  private visibleIn(scope: string | null): Prisma.RoleWhereInput {
    return scope === null
      ? {}
      : { OR: [{ companyId: null }, { companyId: scope }] };
  }

  /**
   * Every role the caller may see, with its assigned-user count.
   *
   * The system roles are global reference data every company shares; a custom role belongs to the
   * company it was made in (036 C10) and is listed only there — or everywhere, with its company
   * named, for a group administrator with no company selected. The counts come from
   * `UsersService`, not a join into `shared.User` — Principle I.
   */
  async findAll(
    caller?: AuthenticatedUser,
    options: {
      /**
       * Only roles every grant of which the caller holds — the set they may actually assign
       * (042), by the same `assertMayGrant` ceiling the invite and user-role endpoints apply
       * on submit. The invite form's role list used to show every visible role and let the
       * server refuse the choice afterwards.
       */
      grantable?: boolean;
    } = {},
  ): Promise<RoleWithAssignedCount[]> {
    const holders = caller
      ? await this.usersService.activeHolderCounts(rlsContextFor(caller))
      : null;
    const scope = caller ? this.scopeOf(caller) : null;
    const roles = await this.prisma.role.findMany({
      where: this.visibleIn(scope),
      orderBy: { name: 'asc' },
      // One query for every role's levels rather than one per role. The set is small — nine seeded
      // roles plus whatever a company has added — but a per-role round trip here is a pattern that
      // gets copied.
      include: {
        rolePermissions: { select: { permission: true, level: true } },
        company: { select: { name: true } },
      },
    });
    const offered =
      options.grantable && caller
        ? roles.filter((role) =>
            mayGrantAll(
              caller,
              expandRoleGrants(
                role.permissions ?? [],
                role.rolePermissions ?? [],
              ),
            ),
          )
        : roles;
    return Promise.all(
      offered.map(async ({ rolePermissions, company, ...role }) => ({
        ...role,
        assignedUserCount: await this.usersService.countByRoleId(role.id),
        ...(holders ? { activeHolderCount: holders.get(role.id) ?? 0 } : {}),
        companyName: company?.name ?? null,
        grants: rolePermissions,
      })),
    );
  }

  /**
   * Refuses a name already used where a role in `companyId` would sit (036 C10): among the global
   * roles and that company's own. A global role's name must be free everywhere, since every company
   * would see it beside its own. Other companies' role names are never consulted for a company
   * role, so the refusal cannot tell one company what another has called its roles.
   */
  private async assertNameFree(
    name: string,
    companyId: string | null,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.prisma.role.findFirst({
      where: {
        name,
        ...(companyId === null ? {} : this.visibleIn(companyId)),
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) this.nameTaken(name);
  }

  private nameTaken(name: string): never {
    throw new ConflictException({
      statusCode: 409,
      code: ROLE_NAME_TAKEN,
      message: `A role named "${name}" already exists`,
    });
  }

  /** The unique indexes are the last word on a race between two creates of one name. */
  private isNameClash(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }

  /** Exported for the Auth module, which needs a role's name and permission set at
   * login time without querying `settings` directly (research.md §3). */
  async getRoleById(id: string): Promise<Role | null> {
    return this.prisma.role.findUnique({ where: { id } });
  }

  /**
   * The `RolePermission` rows a request implies (019 FR-001, FR-002, T041, T042).
   *
   * **No `grants` means read + write on every area named** — which is what holding a
   * permission has always meant, and what the Phase 1 backfill gave every existing role. So an
   * administrator who names no levels gets today's behaviour and no existing caller of these
   * endpoints changes meaning.
   *
   * **Write without read is refused** (T042). The specification left this open as an edge case;
   * refusing is the answer, because a role that may change records it cannot see can neither
   * find what to change nor see what it changed. Definition time is the cheap place to say so —
   * the alternative is discovering it when somebody's screen is empty and their saves succeed.
   */
  private grantRowsFor(dto: {
    permissions?: Permission[];
    grants?: { permission: Permission; level: AccessLevel }[];
  }): { permission: Permission; level: AccessLevel }[] {
    const areas = dto.permissions ?? [];
    if (!dto.grants || dto.grants.length === 0) {
      return areas.flatMap((permission) => [
        { permission, level: AccessLevel.read },
        { permission, level: AccessLevel.write },
      ]);
    }

    const unknown = dto.grants
      .map((g) => g.permission)
      .filter((p) => !areas.includes(p));
    if (unknown.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'GRANT_AREA_NOT_LISTED',
        message:
          `Every area given a level must also appear in "permissions": ` +
          `${[...new Set(unknown)].join(
            ', ',
          )}. That list stays the set of areas the role ` +
          `touches, so the two cannot disagree.`,
      });
    }

    const byArea = new Map<Permission, Set<AccessLevel>>();
    for (const grant of dto.grants) {
      const levels = byArea.get(grant.permission) ?? new Set<AccessLevel>();
      levels.add(grant.level);
      byArea.set(grant.permission, levels);
    }

    const writeOnly = [...byArea.entries()]
      .filter(
        ([, levels]) =>
          levels.has(AccessLevel.write) && !levels.has(AccessLevel.read),
      )
      .map(([permission]) => permission);
    if (writeOnly.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'WRITE_WITHOUT_READ',
        message:
          `These areas were given write access without read: ${writeOnly.join(
            ', ',
          )}. ` +
          `A role that may change records it cannot see can neither find what to change ` +
          `nor see what it changed.`,
      });
    }

    // An area in `permissions` that `grants` says nothing about keeps the default, rather than
    // silently becoming no access — the absence of a level is not a decision to remove one.
    const rows = [...byArea.entries()].flatMap(([permission, levels]) =>
      [...levels].map((level) => ({ permission, level })),
    );
    for (const permission of areas) {
      if (!byArea.has(permission)) {
        rows.push(
          { permission, level: AccessLevel.read },
          { permission, level: AccessLevel.write },
        );
      }
    }
    return rows;
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateRoleDto,
    ipAddress: string,
  ): Promise<RoleWithAssignedCount> {
    const name = dto.name.trim();
    // The caller's company, or global for a group administrator with none selected (036 C10).
    const companyId = this.scopeOf(caller);
    await this.assertNameFree(name, companyId);

    const grantRows = this.grantRowsFor(dto);
    // 2026-10-16 audit, C3: a role grants no more than its author holds.
    assertMayGrant(caller, grantRows, 'create that role');

    // Custom roles are never protected — only the seeded Super Admin row is.
    const created = await this.prisma.role
      .create({
        data: {
          name,
          companyId,
          permissions: dto.permissions,
          isProtected: false,
          homeModule: dto.homeModule ?? null,
          // Both shapes written together, in one statement. `Role.permissions` is on its way
          // out (019 Phase 1) but is still what the rest of the codebase reads, so the two must
          // never be written apart — a role whose array and rows disagreed would grant one thing
          // to the guard and another to every service-level check.
          rolePermissions: { create: grantRows },
        },
      })
      .catch((err: unknown) => {
        if (this.isNameClash(err)) this.nameTaken(name);
        throw err;
      });

    await this.auditLog.record({
      entityType: AuditEntityType.ROLE,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: caller.companyId,
      ipAddress,
    });
    await this.recordCashEntryChange(
      caller,
      created.id,
      [],
      grantRows,
      ipAddress,
    );
    // The grants as written, so the screen can show what it just saved without a second read.
    return { ...created, assignedUserCount: 0, grants: grantRows };
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateRoleDto,
    ipAddress: string,
  ): Promise<RoleWithAssignedCount> {
    const existing = await this.requireRole(id, caller);
    // Checked before touching the database, and regardless of who is asking — the
    // Super Admin role's name and permission set are immutable (FR-008). Its landing page is
    // not part of that (029 FR-020): where an administrator starts their day grants nothing.
    const onlyHomeModule = Object.keys(dto).every(
      (key) => key === 'homeModule',
    );
    if (!onlyHomeModule) {
      this.assertNotProtected(existing, 'edited');
    }
    // Always, home page included: it changes where every holder of the role lands, in every
    // company that uses it.
    await this.assertOnlyCallersCompany(caller, id, 'edit');

    const name = dto.name?.trim();
    if (name && name !== existing.name) {
      await this.assertNameFree(name, existing.companyId, id);
    }

    // Read before the replace, so the cash-entry audit entry below can say what changed. One
    // query, and only when the request actually replaces the grants.
    const existingGrants = dto.permissions
      ? await this.prisma.rolePermission.findMany({
          where: { roleId: id },
          select: { permission: true, level: true },
        })
      : [];

    // Replace rather than merge: a level removed from the request must be removed from the
    // role, and a merge would make un-granting impossible through this endpoint.
    const grantRows = dto.permissions
      ? this.grantRowsFor({ permissions: dto.permissions, grants: dto.grants })
      : null;
    if (grantRows)
      assertMayGrant(caller, grantRows, 'give that role these permissions');

    const updated = await this.prisma.role
      .update({
        where: { id },
        data: {
          ...(name ? { name } : {}),
          ...(dto.permissions ? { permissions: dto.permissions } : {}),
          ...(dto.homeModule !== undefined
            ? { homeModule: dto.homeModule }
            : {}),
          ...(grantRows
            ? { rolePermissions: { deleteMany: {}, create: grantRows } }
            : {}),
        },
      })
      .catch((err: unknown) => {
        if (name && this.isNameClash(err)) this.nameTaken(name);
        throw err;
      });

    await this.auditLog.record({
      entityType: AuditEntityType.ROLE,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: {
        before: existing,
        after: updated,
      } as unknown as Prisma.InputJsonValue,
      accountId: caller.id,
      companyId: caller.companyId,
      ipAddress,
    });
    if (grantRows) {
      await this.recordCashEntryChange(
        caller,
        id,
        existingGrants,
        grantRows,
        ipAddress,
      );
    }
    return {
      ...updated,
      assignedUserCount: await this.usersService.countByRoleId(id),
      // What this request wrote, or what was already there when it named no levels. Read back
      // rather than assumed in the second case: an update that changes only the name must not
      // report an empty grant set and have the screen render the role as touching nothing.
      grants:
        grantRows ??
        (await this.prisma.rolePermission.findMany({
          where: { roleId: id },
          select: { permission: true, level: true },
        })),
    };
  }

  /**
   * Records a change to who may take cash, separately from the role update that carried it
   * (019 FR-017b, task T080).
   *
   * The role update is already audited with a before/after of the whole row, which is how every
   * other permission change is accounted for and is not enough here. Granting somebody the right
   * to take cash is at least as consequential as hiding the figures, and FR-012 requires an
   * explicit record for the second — so finding the first should not mean diffing two
   * thirty-element arrays across every role edit in the log.
   *
   * Written only when the grant actually changes. An audit entry on every role edit that merely
   * *mentions* cash entry would bury the handful that changed it.
   */
  private async recordCashEntryChange(
    caller: AuthenticatedUser,
    roleId: string,
    before: { permission: Permission; level: AccessLevel }[],
    after: { permission: Permission; level: AccessLevel }[],
    ipAddress: string,
  ): Promise<void> {
    const levelsOf = (rows: { permission: Permission; level: AccessLevel }[]) =>
      rows
        .filter((row) => row.permission === Permission.CASH_ENTRY)
        .map((row) => row.level)
        .sort()
        .join(',');
    const had = levelsOf(before);
    const has = levelsOf(after);
    if (had === has) return;

    await this.auditLog.record({
      entityType: AuditEntityType.ROLE,
      action: AuditAction.UPDATE,
      entityId: roleId,
      changes: {
        // A fixed key, so this is one grep and not a diff. The levels are spelled out because
        // `write` and `read` are different rights here — recording cash and seeing a
        // denomination breakup — and "cash entry changed" would not say which was given.
        cashEntry: { before: had || null, after: has || null },
      } as unknown as Prisma.InputJsonValue,
      accountId: caller.id,
      companyId: caller.companyId,
      ipAddress,
    });
  }

  /**
   * Deletes a role and clears it from everyone holding it (FR-010), so no account is
   * left pointing at a role that no longer exists. Affected accounts lose the access
   * that role granted on their very next request (FR-012) — the guard reads
   * permissions per request, so nothing is cached past it.
   */
  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<{ clearedAssignments: number }> {
    const existing = await this.requireRole(id, caller);
    this.assertNotProtected(existing, 'deleted');
    await this.assertOnlyCallersCompany(caller, id, 'delete');
    // New accounts are given this role when the creator names none (029 FR-001); deleting it
    // would turn every such creation into a refusal.
    if (existing.isDefault) {
      throw new ConflictException(
        `The ${existing.name} role is the default for new accounts and cannot be deleted.`,
      );
    }

    const clearedAssignments = await this.usersService.clearRoleAssignment(id);
    await this.prisma.role.delete({ where: { id } });

    await this.auditLog.record({
      entityType: AuditEntityType.ROLE,
      action: AuditAction.DELETE,
      entityId: id,
      changes: {
        before: existing,
        clearedAssignments,
      } as unknown as Prisma.InputJsonValue,
      accountId: caller.id,
      companyId: caller.companyId,
      ipAddress,
    });
    return { clearedAssignments };
  }

  /**
   * The role, if the caller may see it (036 C10): another company's role is as absent as one that
   * does not exist, so its id confirms nothing.
   */
  private async requireRole(
    id: string,
    caller: AuthenticatedUser,
  ): Promise<Role> {
    const role = await this.prisma.role.findFirst({
      where: { id, ...this.visibleIn(this.scopeOf(caller)) },
    });
    if (!role) {
      throw new NotFoundException(`Role ${id} not found`);
    }
    return role;
  }

  /**
   * A global role — one "Site Admin" serves every company — changed from one company lands on every
   * other company's accounts holding it (2026-10-16 audit, C3). A company's own role (036 C10) is
   * held only there, so this passes for it unless an older assignment says otherwise. A company-scoped
   * administrator may therefore change only a role nobody outside their company holds; a role in
   * wider use is a group administrator's to change.
   */
  private async assertOnlyCallersCompany(
    caller: AuthenticatedUser,
    roleId: string,
    verb: string,
  ): Promise<void> {
    if (caller.permissions.includes(Permission.CROSS_COMPANY_ACCESS)) return;
    const elsewhere = await this.usersService.countRoleHoldersOutside(
      roleId,
      caller.companyId,
    );
    if (elsewhere > 0) {
      throw new ForbiddenException({
        code: 'ROLE_SHARED_ACROSS_COMPANIES',
        message: `This role is also held by accounts outside your company, so only a group administrator can ${verb} it. Create a role of your own instead.`,
      });
    }
  }

  private assertNotProtected(role: Role, verb: string): void {
    if (role.isProtected) {
      throw new ForbiddenException(
        `The ${role.name} role is protected and cannot be ${verb}`,
      );
    }
  }
}
