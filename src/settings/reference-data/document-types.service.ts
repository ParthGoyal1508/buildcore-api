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
import {
  rlsContextFor,
  withRlsContext,
  type RlsContext,
} from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../company-scope';
import { DEFAULT_DOCUMENT_TYPES } from './default-document-types';
import { scopeForCode, type RequiredDocumentKind } from '../document-kinds';
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

/** Derived once, never restated — `scopeForCode` needs the employee file's codes. */
const DEFAULT_DOCUMENT_TYPE_CODES = DEFAULT_DOCUMENT_TYPES.map((d) => d.code);

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
        // `scope` through the shared rule (017 amendment) rather than left to the column
        // default. The default is `both`, which is right for a row nobody classified and
        // wrong for these: every company created after the scope migration would get its
        // seventeen employee defaults showing up in the Company Documents list beside the
        // GST certificate, and the migration's backfill only ever reaches rows that
        // existed when it ran.
        data: DEFAULT_DOCUMENT_TYPES.map((d) => ({
          ...d,
          companyId,
          scope: scopeForCode(d.code, DEFAULT_DOCUMENT_TYPE_CODES),
        })),
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
          where: {
            ...companyScope(caller, companyId),
            // The employee file only (017 amendment). Before the scope column this
            // returned the organisation's statutory kinds too — GST, work order, BOQ —
            // mixed in among the marksheets, in every company.
            scope: { in: ['employee', 'both'] },
          },
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
            // This is the Employee Setup master's create route, so what it creates is an
            // employee document type (017 amendment). The column default is `both`,
            // which is right for a row nobody classified and wrong for one created here
            // by somebody looking at the employee file.
            scope: 'employee',
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
  /**
   * Brings a kind this product *declares* into existence for a company (FR-003a, FR-007a).
   *
   * Lives here because this service owns `settings.DocumentType`. Every field of the row
   * comes from the `RequiredDocumentKind` handed in, so a caller supplies no name, no
   * flags and no scope — only which declared kind to materialise.
   *
   * **It validates no code set of its own, deliberately.** Each caller resolves against
   * the set it is entitled to: company documents against the eight under
   * `COMPANY_SETTINGS`, project requirements against the six under `SETTINGS`. A shared
   * method checking the union of both would quietly hand each surface the other's list,
   * which is the permission boundary this arrangement exists to hold (plan D8).
   *
   * Idempotent: two administrators clicking at the same moment produce one type and two
   * successful responses, not a unique violation on `(companyId, code)`.
   */
  async defineDeclaredKind(
    ctx: RlsContext,
    companyId: string,
    kind: RequiredDocumentKind,
    actor: { userId: string; ipAddress: string },
  ): Promise<{ documentTypeId: string; code: string; name: string }> {
    const existing = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.documentType.findFirst({
        where: { companyId, code: kind.code },
        select: { id: true, code: true, name: true },
      }),
    );
    if (existing) {
      return {
        documentTypeId: existing.id,
        code: existing.code,
        name: existing.name,
      };
    }

    const created = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.documentType.create({
        data: {
          companyId,
          code: kind.code,
          name: kind.label,
          isMandatory: false,
          hasExpiry: kind.hasExpiry,
          needsNumber: kind.needsNumber,
          isRestricted: kind.isRestricted ?? false,
          // Aadhaar and PAN come out `both`: required of the company and held on an
          // employee's file. The rule is `scopeForCode`, shared with the backfill.
          scope: scopeForCode(kind.code, DEFAULT_DOCUMENT_TYPE_CODES),
          // Below the defaults seeded at company creation, which start at 10 and step by
          // ten. A statutory paper defined later belongs after the employee file rather
          // than interleaved with it.
          sortOrder: 500,
        },
        select: { id: true, code: true, name: true },
      }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.DOCUMENT_TYPE,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: { documentTypeCode: created.code, definedFor: 'declared-kind' },
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });

    return {
      documentTypeId: created.id,
      code: created.code,
      name: created.name,
    };
  }

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
