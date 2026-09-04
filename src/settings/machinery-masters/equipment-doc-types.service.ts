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
import { DEFAULT_EQUIPMENT_DOC_TYPES } from '../../plant/constants/plant.constants';
import { assertInScope, companyScope } from '../company-scope';
import {
  CreateEquipmentDocTypeDto,
  UpdateEquipmentDocTypeDto,
} from './dto/machinery-masters.dto';

export interface EquipmentDocTypeView {
  id: string;
  companyId: string;
  name: string;
  /** The per-type alert window FR-010 requires instead of a hardcoded 30 days. */
  alertDays: number;
  active: boolean;
  createdAt: Date;
}

/**
 * Equipment document type master (006 FR-013).
 *
 * The reason this exists as a master at all rather than the fixed enum the original
 * spec carried: `alertDays` is per type. An insurance policy wants six weeks'
 * notice, a pollution certificate a fortnight, and an enum cannot hold a number.
 * research.md §10 records the correction.
 */
@Injectable()
export class EquipmentDocTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async seedDefaultsForCompany(
    companyId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.equipmentDocType.createMany({
      data: DEFAULT_EQUIPMENT_DOC_TYPES.map((type) => ({
        companyId,
        name: type.name,
        alertDays: type.alertDays,
      })),
      skipDuplicates: true,
    });
  }

  private normalise(name: string): string {
    return name.trim().toUpperCase();
  }

  private toView(row: {
    id: string;
    companyId: string;
    name: string;
    alertDays: number;
    active: boolean;
    createdAt: Date;
  }): EquipmentDocTypeView {
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
  ): Promise<EquipmentDocTypeView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipmentDocType.findMany({
          where: companyScope(caller, companyId),
          orderBy: { name: 'asc' },
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  /**
   * Doc types for a list of ids, in one query.
   *
   * This is what the equipment register's `expiryAlert` computation reads: one
   * lookup for the whole page rather than one per document (FR-010, SC-001).
   */
  async getDocTypesByIds(
    caller: AuthenticatedUser,
    docTypeIds: string[],
  ): Promise<Map<string, EquipmentDocTypeView>> {
    const unique = [...new Set(docTypeIds)];
    if (unique.length === 0) return new Map();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipmentDocType.findMany({
          where: { id: { in: unique }, ...companyScope(caller) },
        }),
    );
    return new Map(rows.map((row) => [row.id, this.toView(row)]));
  }

  async getDocType(
    caller: AuthenticatedUser,
    docTypeId: string,
  ): Promise<EquipmentDocTypeView | null> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.equipmentDocType.findUnique({ where: { id: docTypeId } }),
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

  async create(
    caller: AuthenticatedUser,
    dto: CreateEquipmentDocTypeDto,
    ipAddress: string,
    requestedCompanyId?: string,
  ): Promise<EquipmentDocTypeView> {
    const scope = companyScope(caller, requestedCompanyId);
    const companyId = scope.companyId ?? caller.companyId;
    if (!companyId) {
      throw new ConflictException(
        'companyId is required for a cross-company caller.',
      );
    }
    const name = this.normalise(dto.name);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const clash = await tx.equipmentDocType.findFirst({
          where: { companyId, name },
        });
        if (clash) {
          throw new ConflictException(
            `An equipment document type named ${name} already exists.`,
          );
        }
        return tx.equipmentDocType.create({
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
      entityType: AuditEntityType.EQUIPMENT_DOC_TYPE,
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
    dto: UpdateEquipmentDocTypeDto,
    ipAddress: string,
  ): Promise<EquipmentDocTypeView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.equipmentDocType.findUnique({
          where: { id: docTypeId },
        });
        if (!existing) throw new NotFoundException('Document type not found');
        assertInScope(caller, existing, 'Document type');

        const name = dto.name ? this.normalise(dto.name) : undefined;
        if (name && name !== existing.name) {
          const clash = await tx.equipmentDocType.findFirst({
            where: { companyId: existing.companyId, name },
          });
          if (clash) {
            throw new ConflictException(
              `An equipment document type named ${name} already exists.`,
            );
          }
        }

        return tx.equipmentDocType.update({
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
      entityType: AuditEntityType.EQUIPMENT_DOC_TYPE,
      action: AuditAction.UPDATE,
      entityId: updated.id,
      companyId: updated.companyId,
      ipAddress,
      changes: { ...dto },
    });
    return this.toView(updated);
  }
}
