import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../company-scope';

export interface KitItemView {
  id: string;
  companyId: string;
  name: string;
  linkedInventoryItemId: string | null;
  defaultQuantity: number;
  issuedByDefault: boolean;
  isRecoverableAtExit: boolean;
  isActive: boolean;
}

/**
 * Kit item master (011 FR-037) — a `settings`-schema reference master owned and
 * audited by feature 011, the same arrangement `SkillCategory`/`Item` use. The
 * deletion-in-use guard is left to the recruitment module (only it may count
 * onboarding items), exactly as `ItemsService.remove` leaves its stock check to
 * inventory.
 */
@Injectable()
export class KitItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private toView(row: {
    id: string;
    companyId: string;
    name: string;
    linkedInventoryItemId: string | null;
    defaultQuantity: number;
    issuedByDefault: boolean;
    isRecoverableAtExit: boolean;
    isActive: boolean;
  }): KitItemView {
    return { ...row };
  }

  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<KitItemView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.kitItem.findMany({
          where: companyScope(caller, companyId),
          orderBy: { name: 'asc' },
        }),
    );
    return rows.map((r) => this.toView(r));
  }

  /** Default kit items that seed a new onboarding checklist (issuedByDefault). */
  async defaultsForCompany(
    caller: AuthenticatedUser,
    companyId: string,
    tx: Prisma.TransactionClient,
  ): Promise<KitItemView[]> {
    const rows = await tx.kitItem.findMany({
      where: { companyId, issuedByDefault: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      name: string;
      linkedInventoryItemId?: string;
      defaultQuantity?: number;
      issuedByDefault?: boolean;
      isRecoverableAtExit?: boolean;
    },
    ipAddress: string,
  ): Promise<KitItemView> {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      // A 400, not a 404: the company is not missing — the caller never named one.
      // A cross-company Super Admin has no `companyId` of their own for
      // `companyScope()` to fall back on, so a write from them must say which
      // company it belongs to. Reporting "Company not found" sent people hunting
      // for a deleted company instead of picking one. Same message every other
      // module uses for this case.
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    const name = dto.name.trim();

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const clash = await tx.kitItem.findFirst({
          where: { companyId, name },
        });
        if (clash) {
          throw new ConflictException(
            `A kit item named "${name}" already exists`,
          );
        }
        return tx.kitItem.create({
          data: {
            companyId,
            name,
            linkedInventoryItemId: dto.linkedInventoryItemId ?? null,
            defaultQuantity: dto.defaultQuantity ?? 1,
            issuedByDefault: dto.issuedByDefault ?? true,
            isRecoverableAtExit: dto.isRecoverableAtExit ?? false,
          },
        });
      },
    );

    await this.audit(
      AuditAction.CREATE,
      created.id,
      companyId,
      caller,
      ipAddress,
    );
    return this.toView(created);
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: {
      name?: string;
      linkedInventoryItemId?: string | null;
      defaultQuantity?: number;
      issuedByDefault?: boolean;
      isRecoverableAtExit?: boolean;
      isActive?: boolean;
    },
    ipAddress: string,
  ): Promise<KitItemView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.kitItem.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException(`Kit item ${id} not found`);
        assertInScope(caller, existing, `Kit item ${id}`);
        return tx.kitItem.update({
          where: { id },
          data: {
            name: dto.name?.trim() ?? undefined,
            linkedInventoryItemId:
              dto.linkedInventoryItemId === undefined
                ? undefined
                : dto.linkedInventoryItemId,
            defaultQuantity: dto.defaultQuantity ?? undefined,
            issuedByDefault: dto.issuedByDefault ?? undefined,
            isRecoverableAtExit: dto.isRecoverableAtExit ?? undefined,
            isActive: dto.isActive ?? undefined,
          },
        });
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      id,
      updated.companyId,
      caller,
      ipAddress,
    );
    return this.toView(updated);
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      // Kit items are onboarding entities; audited under the recruitment feature.
      entityType: AuditEntityType.ONBOARDING_ITEM,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
