import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma, Role } from '@prisma/client';
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

    // Custom roles are never protected — only the seeded Super Admin row is.
    const created = await this.prisma.role.create({
      data: { name, permissions: dto.permissions, isProtected: false },
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

    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(dto.permissions ? { permissions: dto.permissions } : {}),
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
