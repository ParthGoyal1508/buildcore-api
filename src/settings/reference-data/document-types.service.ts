import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  DocumentType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../company-scope';
import { DEFAULT_DOCUMENT_TYPES } from './default-document-types';
import {
  DocumentTypeFlag,
  computeDocumentTypeFlag,
} from './document-type-flag';
import {
  CreateDocumentTypeDto,
  UpdateDocumentTypeDto,
} from './dto/document-type.dto';

/** A stored DocumentType plus its computed display flag (research.md §7). */
export type DocumentTypeView = DocumentType & { flag: DocumentTypeFlag };

function toView(documentType: DocumentType): DocumentTypeView {
  return {
    ...documentType,
    flag: computeDocumentTypeFlag(
      documentType.isMandatory,
      documentType.hasExpiry,
      documentType.needsNumber,
    ),
  };
}

@Injectable()
export class DocumentTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Seeds a new company's default document types (FR-020).
   *
   * Takes an optional transaction client so `CompaniesService.create()` can run this
   * inside the same transaction that creates the company — a half-seeded company is
   * not a state worth being able to reach.
   */
  async seedDefaultsForCompany(
    companyId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const run = async (client: Prisma.TransactionClient) => {
      const { count } = await client.documentType.createMany({
        data: DEFAULT_DOCUMENT_TYPES.map((d) => ({ ...d, companyId })),
        // Re-seeding an existing company must not blow up on its existing codes.
        skipDuplicates: true,
      });
      return count;
    };

    if (tx) {
      return run(tx);
    }
    return withRlsContext(this.prisma, { isSuperAdmin: true }, run);
  }

  async findAll(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<DocumentTypeView[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.documentType.findMany({
          where: companyScope(caller, companyId),
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        }),
    );
    return rows.map(toView);
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateDocumentTypeDto,
    ipAddress: string,
  ): Promise<DocumentTypeView> {
    const companyId = this.companyIdFor(caller, dto.companyId);
    const code = dto.code.trim().toUpperCase();

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const clash = await tx.documentType.findFirst({
          where: { companyId, code },
          select: { id: true },
        });
        if (clash) {
          throw new ConflictException(
            `A document type with code ${code} already exists for this company`,
          );
        }
        return tx.documentType.create({
          data: {
            companyId,
            code,
            name: dto.name.trim(),
            isMandatory: dto.isMandatory ?? false,
            hasExpiry: dto.hasExpiry ?? false,
            needsNumber: dto.needsNumber ?? false,
            sortOrder: dto.sortOrder ?? 0,
            isActive: dto.isActive ?? true,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.DOCUMENT_TYPE,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
    return toView(created);
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateDocumentTypeDto,
    ipAddress: string,
  ): Promise<DocumentTypeView> {
    const { before, updated } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.documentType.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Document type ${id} not found`);
        }
        assertInScope(caller, existing, `Document type ${id}`);

        const code = dto.code?.trim().toUpperCase();
        if (code && code !== existing.code) {
          const clash = await tx.documentType.findFirst({
            where: { companyId: existing.companyId, code },
            select: { id: true },
          });
          if (clash) {
            throw new ConflictException(
              `A document type with code ${code} already exists for this company`,
            );
          }
        }

        const row = await tx.documentType.update({
          where: { id },
          data: {
            ...(code ? { code } : {}),
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.isMandatory !== undefined
              ? { isMandatory: dto.isMandatory }
              : {}),
            ...(dto.hasExpiry !== undefined
              ? { hasExpiry: dto.hasExpiry }
              : {}),
            ...(dto.needsNumber !== undefined
              ? { needsNumber: dto.needsNumber }
              : {}),
            ...(dto.sortOrder !== undefined
              ? { sortOrder: dto.sortOrder }
              : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
        });
        return { before: existing, updated: row };
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.DOCUMENT_TYPE,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { before, after: updated } as unknown as Prisma.InputJsonValue,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return toView(updated);
  }

  /**
   * Which of a company's mandatory document types an employee does not yet have on
   * file (FR-021, SC-006). Exported from `SettingsModule` for the future
   * Employees/Attendance module to call before marking attendance — this feature
   * owns the *check*, not attendance marking or document storage.
   */
  /**
   * A company's document types by company id, for callers outside `settings`.
   *
   * `findAll` takes an `AuthenticatedUser` because it backs the Settings UI, where
   * the caller's own scope decides what they see. Cross-module callers (005's
   * employee documents) have already resolved and authorised the company, so they
   * need the master by id — the same shape `hasMissingMandatoryDocs` below takes.
   * Exposing this keeps `hr` out of the `settings` schema (Principle I).
   */
  async listForCompany(companyId: string): Promise<DocumentType[]> {
    return withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.documentType.findMany({
        where: { companyId },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }),
    );
  }

  async hasMissingMandatoryDocs(
    companyId: string,
    employeeDocumentTypeIds: string[],
  ): Promise<{ missing: DocumentType[] }> {
    const mandatory = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.documentType.findMany({
          where: { companyId, isMandatory: true, isActive: true },
          orderBy: { sortOrder: 'asc' },
        }),
    );
    const held = new Set(employeeDocumentTypeIds);
    return { missing: mandatory.filter((d) => !held.has(d.id)) };
  }

  /** A cross-company caller must say which company they mean; everyone else is
   * pinned to their own, so a companyId in the body can never widen their scope. */
  private companyIdFor(caller: AuthenticatedUser, requested?: string): string {
    const ctx = rlsContextFor(caller);
    if (ctx.isSuperAdmin) {
      const companyId = requested ?? caller.companyId;
      if (!companyId) {
        throw new NotFoundException(
          'companyId is required for a cross-company caller',
        );
      }
      return companyId;
    }
    if (!caller.companyId) {
      throw new NotFoundException('Caller has no company assigned');
    }
    return caller.companyId;
  }
}
