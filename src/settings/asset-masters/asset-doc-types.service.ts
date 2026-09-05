import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { DEFAULT_ASSET_DOC_TYPES } from '../../assets/constants/assets.constants';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../company-scope';
import {
  CreateAssetDocTypeDto,
  UpdateAssetDocTypeDto,
} from './dto/asset-masters.dto';

export interface AssetDocTypeView {
  id: string;
  companyId: string;
  name: string;
  /** The document's own notice window — see the model comment for why it is per
   * type rather than a module constant. */
  alertDays: number;
  active: boolean;
  createdAt: Date;
}

/**
 * Asset document-type master (spec FR-025).
 *
 * The mirror of `EquipmentDocTypesService`, table for table. As there, the delete
 * guard — "is any document filed under this type?" — counts rows in another schema
 * (`assets.AssetDocument`) and so lives on the assets side.
 */
@Injectable()
export class AssetDocTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async seedDefaultsForCompany(
    companyId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.assetDocType.createMany({
      data: DEFAULT_ASSET_DOC_TYPES.map((docType) => ({
        companyId,
        name: docType.name,
        alertDays: docType.alertDays,
      })),
      skipDuplicates: true,
    });
  }

  private normalise(name: string): string {
    return name.trim().toUpperCase();
  }

  private toView(row: Prisma.AssetDocTypeGetPayload<object>): AssetDocTypeView {
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      alertDays: row.alertDays,
      active: row.active,
      createdAt: row.createdAt,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<AssetDocTypeView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.assetDocType.findMany({
          where: companyScope(caller, companyId),
          orderBy: { name: 'asc' },
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  async getDocType(
    caller: AuthenticatedUser,
    docTypeId: string,
  ): Promise<AssetDocTypeView | null> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.assetDocType.findUnique({ where: { id: docTypeId } }),
    );
    if (!row) return null;
    if (
      !rlsContextFor(caller).isSuperAdmin &&
      row.companyId !== caller.companyId
    ) {
      return null;
    }
    return this.toView(row);
  }

  async getDocTypesByIds(
    caller: AuthenticatedUser,
    docTypeIds: string[],
  ): Promise<Map<string, AssetDocTypeView>> {
    const unique = [...new Set(docTypeIds)];
    if (unique.length === 0) return new Map();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.assetDocType.findMany({
          where: { id: { in: unique }, ...companyScope(caller) },
        }),
    );
    return new Map(rows.map((row) => [row.id, this.toView(row)]));
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateAssetDocTypeDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<AssetDocTypeView> {
    const scope = companyScope(caller, requestedCompanyId);
    const companyId = scope.companyId ?? caller.companyId;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    const name = this.normalise(dto.name);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const clash = await tx.assetDocType.findFirst({
          where: { companyId, name },
        });
        if (clash) {
          throw new ConflictException(
            `An asset document type named ${name} already exists.`,
          );
        }
        return tx.assetDocType.create({
          data: {
            companyId,
            name,
            ...(dto.alertDays !== undefined
              ? { alertDays: dto.alertDays }
              : {}),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET_DOC_TYPE,
      action: AuditAction.CREATE,
      entityId: created.id,
      companyId,
      ipAddress,
      changes: { name: created.name, alertDays: created.alertDays },
    });
    return this.toView(created);
  }

  async update(
    caller: AuthenticatedUser,
    docTypeId: string,
    dto: UpdateAssetDocTypeDto,
    ipAddress: string,
  ): Promise<AssetDocTypeView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.assetDocType.findUnique({
          where: { id: docTypeId },
        });
        if (!existing)
          throw new NotFoundException('Asset document type not found');
        assertInScope(caller, existing, 'Asset document type');

        const name = dto.name ? this.normalise(dto.name) : undefined;
        if (name && name !== existing.name) {
          const clash = await tx.assetDocType.findFirst({
            where: { companyId: existing.companyId, name },
          });
          if (clash) {
            throw new ConflictException(
              `An asset document type named ${name} already exists.`,
            );
          }
        }

        return tx.assetDocType.update({
          where: { id: docTypeId },
          data: {
            ...(name ? { name } : {}),
            ...(dto.alertDays !== undefined
              ? { alertDays: dto.alertDays }
              : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET_DOC_TYPE,
      action: AuditAction.UPDATE,
      entityId: updated.id,
      companyId: updated.companyId,
      ipAddress,
      changes: { ...dto },
    });
    return this.toView(updated);
  }

  /** Deletes a doc type. The caller must already have established that no document
   * is filed under it. */
  async remove(
    caller: AuthenticatedUser,
    docTypeId: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.assetDocType.findUnique({
          where: { id: docTypeId },
        });
        if (!existing)
          throw new NotFoundException('Asset document type not found');
        assertInScope(caller, existing, 'Asset document type');
        await tx.assetDocType.delete({ where: { id: docTypeId } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.ASSET_DOC_TYPE,
      action: AuditAction.DELETE,
      entityId: docTypeId,
      companyId: removed.companyId,
      ipAddress,
      changes: { name: removed.name },
    });
  }
}
