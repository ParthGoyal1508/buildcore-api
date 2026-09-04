import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';

export interface GangView {
  id: string;
  name: string;
  gangLeaderWorkerId: string;
  siteId: string;
  isActive: boolean;
  memberWorkerIds: string[];
}

@Injectable()
export class GangService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: { companyId?: string; siteId?: string },
  ): Promise<GangView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourGang.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            deletedAt: null,
            ...(query.siteId ? { siteId: query.siteId } : {}),
          },
          orderBy: { name: 'asc' },
          include: { members: { where: { isActive: true } } },
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  async findOne(caller: AuthenticatedUser, id: string): Promise<GangView> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.labourGang.findUnique({
        where: { id },
        include: { members: { where: { isActive: true } } },
      }),
    );
    if (!row || row.deletedAt) {
      throw new NotFoundException(`Gang ${id} not found`);
    }
    assertInScope(caller, row, `Gang ${id}`);
    return this.toView(row);
  }

  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      name: string;
      gangLeaderWorkerId: string;
      siteId: string;
      memberWorkerIds: string[];
    },
    ipAddress: string,
  ): Promise<GangView> {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      throw new NotFoundException('Company not found');
    }

    // A gang leader is a member of their own gang.
    const memberIds = Array.from(
      new Set([dto.gangLeaderWorkerId, ...dto.memberWorkerIds]),
    );

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const alreadyGanged = await tx.gangMember.findFirst({
          where: { workerId: { in: memberIds }, isActive: true },
        });
        if (alreadyGanged) {
          throw new ConflictException({
            message: 'A worker is already in another active gang',
            workerId: alreadyGanged.workerId,
          });
        }

        return tx.labourGang.create({
          data: {
            companyId,
            name: dto.name.trim(),
            gangLeaderWorkerId: dto.gangLeaderWorkerId,
            siteId: dto.siteId,
            createdBy: caller.id,
            members: {
              create: memberIds.map((workerId) => ({
                companyId,
                workerId,
                isActive: true,
              })),
            },
          },
          include: { members: { where: { isActive: true } } },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_GANG,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
    return this.toView(created);
  }

  /** The active worker ids in a gang — the batch a muster bulk-add expands. */
  async activeMemberIds(
    tx: Prisma.TransactionClient,
    gangId: string,
  ): Promise<string[]> {
    const members = await tx.gangMember.findMany({
      where: { gangId, isActive: true },
      select: { workerId: true },
    });
    return members.map((m) => m.workerId);
  }

  private toView(row: {
    id: string;
    name: string;
    gangLeaderWorkerId: string;
    siteId: string;
    isActive: boolean;
    members: { workerId: string }[];
  }): GangView {
    return {
      id: row.id,
      name: row.name,
      gangLeaderWorkerId: row.gangLeaderWorkerId,
      siteId: row.siteId,
      isActive: row.isActive,
      memberWorkerIds: row.members.map((m) => m.workerId),
    };
  }
}
