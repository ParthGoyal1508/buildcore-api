import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Client,
  ClientStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../constants/projects.constants';
import { CreateClientDto } from './dto/create-client.dto';
import { ListClientsDto } from './dto/list-clients.dto';
import { UpdateClientDto } from './dto/update-client.dto';

export interface ClientListItem {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  status: ClientStatus;
  /** How many projects name this client — the list's "is this safe to delete" column. */
  projectCount: number;
}

export interface ClientListPage {
  items: ClientListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Client master (008 US1).
 *
 * @see ProjectsService for the portfolio that references these rows.
 */
@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Which company a create belongs to.
   *
   * `companyScope` returns no company at all for a cross-company caller, which is
   * right for a list (they see every company) but not for a create, which has to name
   * one. Falling back to the caller's own company is the same order
   * `VendorCategoriesService.create()`, `VendorsService.create()` and
   * `SitesController.list()` use — and 007 shipped without it, which is what made
   * "Add vendor category" fail for an admin who simply had not picked a company.
   */
  private targetCompanyOf(
    caller: AuthenticatedUser,
    requested?: string,
  ): string {
    const scope = companyScope(caller, requested);
    const companyId = scope.companyId ?? caller.companyId;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  /**
   * Refuses a GSTIN already on file for this company.
   *
   * Checked explicitly rather than left to the partial unique index, so the caller
   * gets "GSTIN … already belongs to <name>" instead of a bare constraint violation.
   * The index still exists and is still the real guarantee — this check races with a
   * concurrent create, and losing that race must fail rather than duplicate. The
   * global `PrismaClientExceptionFilter` maps the resulting P2002 to 409, so both
   * paths reach the client as the same status.
   */
  private async assertGstinFree(
    tx: Prisma.TransactionClient,
    companyId: string,
    gstin: string | null | undefined,
    exceptClientId?: string,
  ): Promise<void> {
    if (!gstin) return;
    const clash = await tx.client.findFirst({
      where: {
        companyId,
        gstin,
        ...(exceptClientId ? { id: { not: exceptClientId } } : {}),
      },
      select: { name: true },
    });
    if (clash) {
      throw new ConflictException(
        `GSTIN ${gstin} already belongs to client "${clash.name}".`,
      );
    }
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateClientDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<Client> {
    const targetCompanyId = this.targetCompanyOf(caller, companyId);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        await this.assertGstinFree(tx, targetCompanyId, dto.gstin);
        return tx.client.create({
          data: {
            companyId: targetCompanyId,
            name: dto.name.trim(),
            contactPerson: dto.contactPerson ?? null,
            phone: dto.phone ?? null,
            email: dto.email ?? null,
            address: dto.address ?? null,
            gstin: dto.gstin ?? null,
            status: dto.status ?? ClientStatus.active,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.CLIENT,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
    });
    return created;
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListClientsDto,
  ): Promise<ClientListPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE),
    );

    const where: Prisma.ClientWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              {
                contactPerson: { contains: query.search, mode: 'insensitive' },
              },
              { gstin: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const [rows, total] = await Promise.all([
        tx.client.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          // Counted in the same query rather than fetched per row: the list is
          // paginated, so this is one join and not N follow-up queries.
          include: { _count: { select: { projects: true } } },
        }),
        tx.client.count({ where }),
      ]);

      return {
        items: rows.map((client) => ({
          id: client.id,
          name: client.name,
          contactPerson: client.contactPerson,
          phone: client.phone,
          email: client.email,
          gstin: client.gstin,
          status: client.status,
          projectCount: client._count.projects,
        })),
        total,
        page,
        pageSize,
      };
    });
  }

  async findOne(caller: AuthenticatedUser, id: string): Promise<Client> {
    const client = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.client.findUnique({ where: { id } }),
    );
    if (!client) {
      throw new NotFoundException(`Client ${id} not found`);
    }
    assertInScope(caller, client, `Client ${id}`);
    return client;
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateClientDto,
    ipAddress: string,
  ): Promise<Client> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.client.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Client ${id} not found`);
        }
        assertInScope(caller, existing, `Client ${id}`);
        await this.assertGstinFree(tx, existing.companyId, dto.gstin, id);

        return tx.client.update({
          where: { id },
          data: {
            // Each field is applied only when the caller actually sent it. Spreading
            // the DTO wholesale would write `undefined` over columns the client never
            // mentioned — a PATCH must not clear what it does not name.
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.contactPerson !== undefined
              ? { contactPerson: dto.contactPerson || null }
              : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone || null } : {}),
            ...(dto.email !== undefined ? { email: dto.email || null } : {}),
            ...(dto.address !== undefined
              ? { address: dto.address || null }
              : {}),
            ...(dto.gstin !== undefined ? { gstin: dto.gstin || null } : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.CLIENT,
      action: AuditAction.UPDATE,
      entityId: updated.id,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return updated;
  }

  /**
   * Removes a client that no project references.
   *
   * A hard delete, per contracts/projects-api.md — but only once nothing points at
   * the row. `Project.clientId` is a RESTRICT foreign key, so the database would
   * refuse anyway; checking first is what turns an opaque constraint error into a
   * message naming how many projects are in the way. Setting the client inactive is
   * the intended alternative, and the message says so.
   */
  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<{ id: string }> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.client.findUnique({
          where: { id },
          include: { _count: { select: { projects: true } } },
        });
        if (!existing) {
          throw new NotFoundException(`Client ${id} not found`);
        }
        assertInScope(caller, existing, `Client ${id}`);

        if (existing._count.projects > 0) {
          throw new ConflictException(
            `Client "${existing.name}" has ${existing._count.projects} linked ` +
              `project(s) and cannot be deleted. Set it inactive instead.`,
          );
        }

        await tx.client.delete({ where: { id } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.CLIENT,
      action: AuditAction.DELETE,
      entityId: removed.id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
    return { id: removed.id };
  }
}
