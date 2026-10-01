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

/** A role plus how many accounts currently hold it (FR-009). */
export type RoleWithAssignedCount = Role & { assignedUserCount: number };

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
    const roles = await this.prisma.role.findMany({ orderBy: { name: 'asc' } });
    return Promise.all(
      roles.map(async (role) => ({
        ...role,
        assignedUserCount: await this.usersService.countByRoleId(role.id),
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
    return { ...created, assignedUserCount: 0 };
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
    return {
      ...updated,
      assignedUserCount: await this.usersService.countByRoleId(id),
    };
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
