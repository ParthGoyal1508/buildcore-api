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
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { UsersService } from '../../users/users.service';
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
  grants: RoleGrant[];
};

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Every role with its assigned-user count.
   *
   * Role *definitions* are global reference data shared across companies, not
   * tenant-scoped rows, so this is deliberately not company-filtered. The counts
   * come from `UsersService`, not a join into `shared.User` — Principle I.
   */
  async findAll(): Promise<RoleWithAssignedCount[]> {
    const roles = await this.prisma.role.findMany({
      orderBy: { name: 'asc' },
      // One query for every role's levels rather than one per role. The set is small — nine seeded
      // roles plus whatever a company has added — but a per-role round trip here is a pattern that
      // gets copied.
      include: {
        rolePermissions: { select: { permission: true, level: true } },
      },
    });
    return Promise.all(
      roles.map(async ({ rolePermissions, ...role }) => ({
        ...role,
        assignedUserCount: await this.usersService.countByRoleId(role.id),
        grants: rolePermissions,
      })),
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
    const existing = await this.prisma.role.findUnique({ where: { name } });
    if (existing) {
      throw new ConflictException(`A role named "${name}" already exists`);
    }

    const grantRows = this.grantRowsFor(dto);

    // Custom roles are never protected — only the seeded Super Admin row is.
    const created = await this.prisma.role.create({
      data: {
        name,
        permissions: dto.permissions,
        isProtected: false,
        // Both shapes written together, in one statement. `Role.permissions` is on its way
        // out (019 Phase 1) but is still what the rest of the codebase reads, so the two must
        // never be written apart — a role whose array and rows disagreed would grant one thing
        // to the guard and another to every service-level check.
        rolePermissions: { create: grantRows },
      },
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
    const existing = await this.requireRole(id);
    // Checked before touching the database, and regardless of who is asking — the
    // Super Admin role's name and permission set are immutable (FR-008).
    this.assertNotProtected(existing, 'edited');

    const name = dto.name?.trim();
    if (name && name !== existing.name) {
      const clash = await this.prisma.role.findUnique({ where: { name } });
      if (clash) {
        throw new ConflictException(`A role named "${name}" already exists`);
      }
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

    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(dto.permissions ? { permissions: dto.permissions } : {}),
        ...(grantRows
          ? { rolePermissions: { deleteMany: {}, create: grantRows } }
          : {}),
      },
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
    const existing = await this.requireRole(id);
    this.assertNotProtected(existing, 'deleted');

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

  private async requireRole(id: string): Promise<Role> {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) {
      throw new NotFoundException(`Role ${id} not found`);
    }
    return role;
  }

  private assertNotProtected(role: Role, verb: string): void {
    if (role.isProtected) {
      throw new ForbiddenException(
        `The ${role.name} role is protected and cannot be ${verb}`,
      );
    }
  }
}
