import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  LetterType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../company-scope';

export interface LetterTemplateView {
  id: string;
  companyId: string;
  letterType: LetterType;
  name: string;
  bodyTemplate: string;
  letterheadAssetId: string | null;
  isActive: boolean;
}

/**
 * Letter template master (011 FR-020, FR-021) — a `settings`-schema master owned by
 * feature 011. Enforces at most one active template per (company, letterType) by
 * deactivating the prior active one when a template is activated. Token-set
 * validation is the recruitment controller's job (it owns the per-type token sets).
 */
@Injectable()
export class LetterTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private toView(row: {
    id: string;
    companyId: string;
    letterType: LetterType;
    name: string;
    bodyTemplate: string;
    letterheadAssetId: string | null;
    isActive: boolean;
  }): LetterTemplateView {
    return { ...row };
  }

  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<LetterTemplateView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.letterTemplate.findMany({
          where: companyScope(caller, companyId),
          orderBy: [{ letterType: 'asc' }, { name: 'asc' }],
        }),
    );
    return rows.map((r) => this.toView(r));
  }

  /** The active template for a type, resolved during letter generation. Returns null
   * when none is active (the caller raises the FR-020 "missing template" 409). */
  async getActive(
    companyId: string,
    letterType: LetterType,
    tx: Prisma.TransactionClient,
  ): Promise<LetterTemplateView | null> {
    const row = await tx.letterTemplate.findFirst({
      where: { companyId, letterType, isActive: true },
    });
    return row ? this.toView(row) : null;
  }

  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      letterType: LetterType;
      name: string;
      bodyTemplate: string;
      letterheadAssetId?: string;
      isActive?: boolean;
    },
    ipAddress: string,
  ): Promise<LetterTemplateView> {
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

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        if (dto.isActive) {
          await tx.letterTemplate.updateMany({
            where: { companyId, letterType: dto.letterType, isActive: true },
            data: { isActive: false },
          });
        }
        return tx.letterTemplate.create({
          data: {
            companyId,
            letterType: dto.letterType,
            name: dto.name.trim(),
            bodyTemplate: dto.bodyTemplate,
            letterheadAssetId: dto.letterheadAssetId ?? null,
            isActive: dto.isActive ?? false,
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
      bodyTemplate?: string;
      letterheadAssetId?: string | null;
      isActive?: boolean;
    },
    ipAddress: string,
  ): Promise<LetterTemplateView> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.letterTemplate.findUnique({ where: { id } });
        if (!existing)
          throw new NotFoundException(`Letter template ${id} not found`);
        assertInScope(caller, existing, `Letter template ${id}`);

        if (dto.isActive === true && !existing.isActive) {
          await tx.letterTemplate.updateMany({
            where: {
              companyId: existing.companyId,
              letterType: existing.letterType,
              isActive: true,
            },
            data: { isActive: false },
          });
        }
        return tx.letterTemplate.update({
          where: { id },
          data: {
            name: dto.name?.trim() ?? undefined,
            bodyTemplate: dto.bodyTemplate ?? undefined,
            letterheadAssetId:
              dto.letterheadAssetId === undefined
                ? undefined
                : dto.letterheadAssetId,
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
      entityType: AuditEntityType.LETTER,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
