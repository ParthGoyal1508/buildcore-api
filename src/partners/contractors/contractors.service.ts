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
import { StorageService } from '../../common/storage/storage.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { CONTRACTOR_VENDOR_TYPES } from '../vendors/vendors.service';
import {
  CreateContractorDocumentDto,
  CreateContractorDto,
  ListContractorsDto,
  UpdateContractorDto,
} from './dto/contractor.dto';

/** How far ahead an expiry is flagged. A statutory registration that lapses stops a
 * contractor working, so the warning has to arrive with enough time to renew. */
export const EXPIRY_WARNING_DAYS = 30;

/**
 * True when a document expires within the warning window, or has already expired.
 *
 * Derived at read time rather than stored: a boolean written yesterday is wrong
 * today, and a nightly job to keep it true would be a second mechanism doing what
 * one comparison already does.
 */
export function expiryWarningFor(
  expiresAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false;
  const threshold = new Date(now);
  threshold.setDate(threshold.getDate() + EXPIRY_WARNING_DAYS);
  return expiresAt <= threshold;
}

@Injectable()
export class ContractorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly storage: StorageService,
  ) {}

  async create(
    caller: AuthenticatedUser,
    dto: CreateContractorDto,
    ipAddress: string,
  ): Promise<Record<string, unknown>> {
    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const vendor = await tx.vendor.findUnique({
          where: { id: dto.vendorId },
          select: { id: true, companyId: true, type: true, name: true },
        });
        if (!vendor) {
          throw new NotFoundException(`Vendor ${dto.vendorId} not found`);
        }
        assertInScope(caller, vendor, `Vendor ${dto.vendorId}`);

        // A compliance vault only means something for a vendor that supplies labour.
        // Allowing it on a material supplier would put rows in the RAG matrix for
        // companies that owe no PF or ESIC on that relationship at all.
        if (!CONTRACTOR_VENDOR_TYPES.includes(vendor.type)) {
          throw new BadRequestException(
            `${vendor.name} is a ${vendor.type} vendor. A contractor profile can only ` +
              `be created for ${CONTRACTOR_VENDOR_TYPES.join(' or ')} vendors.`,
          );
        }

        const existing = await tx.contractorProfile.findUnique({
          where: { vendorId: dto.vendorId },
          select: { id: true },
        });
        if (existing) {
          throw new ConflictException(
            `${vendor.name} already has a contractor profile.`,
          );
        }

        return tx.contractorProfile.create({
          data: {
            companyId: vendor.companyId,
            vendorId: dto.vendorId,
            licenceNumber: dto.licenceNumber ?? null,
            pfRegistration: dto.pfRegistration ?? null,
            esicRegistration: dto.esicRegistration ?? null,
            bocwRegistration: dto.bocwRegistration ?? null,
            insurancePolicyNumber: dto.insurancePolicyNumber ?? null,
          },
          include: {
            vendor: { select: { name: true, code: true, type: true } },
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.CONTRACTOR_PROFILE,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
    });
    return this.toView(created);
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListContractorsDto,
  ): Promise<Record<string, unknown>[]> {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.contractorProfile.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            ...(query.complianceStatus
              ? { complianceStatus: query.complianceStatus }
              : {}),
            // Inactive vendors drop out of the compliance view entirely: a contractor
            // you have stopped engaging does not belong on a list of who owes filings.
            vendor: { active: true },
          },
          include: {
            vendor: { select: { name: true, code: true, type: true } },
            _count: { select: { documents: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  async findOne(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<Record<string, unknown>> {
    const profile = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.contractorProfile.findUnique({
          where: { id },
          include: {
            vendor: { select: { name: true, code: true, type: true } },
            documents: { orderBy: { uploadedAt: 'desc' } },
          },
        }),
    );
    if (!profile) {
      throw new NotFoundException(`Contractor profile ${id} not found`);
    }
    assertInScope(caller, profile, `Contractor profile ${id}`);

    const now = new Date();
    return {
      ...this.toView(profile),
      documents: profile.documents.map((doc) => ({
        id: doc.id,
        documentType: doc.documentType,
        fileName: doc.fileName,
        expiresAt: doc.expiresAt,
        expiryWarning: expiryWarningFor(doc.expiresAt, now),
        uploadedAt: doc.uploadedAt,
      })),
    };
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateContractorDto,
    ipAddress: string,
  ): Promise<Record<string, unknown>> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.contractorProfile.findUnique({
          where: { id },
        });
        if (!existing) {
          throw new NotFoundException(`Contractor profile ${id} not found`);
        }
        assertInScope(caller, existing, `Contractor profile ${id}`);
        return tx.contractorProfile.update({
          where: { id },
          data: {
            ...(dto.licenceNumber !== undefined
              ? { licenceNumber: dto.licenceNumber ?? null }
              : {}),
            ...(dto.pfRegistration !== undefined
              ? { pfRegistration: dto.pfRegistration ?? null }
              : {}),
            ...(dto.esicRegistration !== undefined
              ? { esicRegistration: dto.esicRegistration ?? null }
              : {}),
            ...(dto.bocwRegistration !== undefined
              ? { bocwRegistration: dto.bocwRegistration ?? null }
              : {}),
            ...(dto.insurancePolicyNumber !== undefined
              ? { insurancePolicyNumber: dto.insurancePolicyNumber ?? null }
              : {}),
          },
          include: {
            vendor: { select: { name: true, code: true, type: true } },
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.CONTRACTOR_PROFILE,
      action: AuditAction.UPDATE,
      entityId: id,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.toView(updated);
  }

  async uploadDocument(
    caller: AuthenticatedUser,
    contractorProfileId: string,
    dto: CreateContractorDocumentDto,
    ipAddress: string,
  ): Promise<Record<string, unknown>> {
    const profile = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.contractorProfile.findUnique({
          where: { id: contractorProfileId },
          select: { id: true, companyId: true },
        }),
    );
    if (!profile) {
      throw new NotFoundException(
        `Contractor profile ${contractorProfileId} not found`,
      );
    }
    assertInScope(caller, profile, `Contractor profile ${contractorProfileId}`);

    // TODO(VIRUS_SCAN): uploads are stored unscanned, the same gap 005's employee
    // documents carry. The scan belongs between decoding and `storage.put`, and is
    // left explicit rather than faked — a no-op scanner reads as protection that is
    // not there.
    const buffer = Buffer.from(dto.file, 'base64');
    if (buffer.length === 0) {
      throw new BadRequestException('file must be non-empty base64 content.');
    }
    const fileRef = await this.storage.put(
      'contractor-documents',
      buffer,
      dto.contentType ?? 'application/octet-stream',
    );

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.contractorDocument.create({
          data: {
            contractorProfileId,
            documentType: dto.documentType,
            fileRef,
            fileName: dto.fileName ?? null,
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
            uploadedByUserId: caller.id,
          },
        }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.CONTRACTOR_DOCUMENT,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: profile.companyId,
      ipAddress,
    });

    return {
      id: created.id,
      documentType: created.documentType,
      fileName: created.fileName,
      expiresAt: created.expiresAt,
      expiryWarning: expiryWarningFor(created.expiresAt),
      uploadedAt: created.uploadedAt,
    };
  }

  async deleteDocument(
    caller: AuthenticatedUser,
    documentId: string,
    ipAddress: string,
  ): Promise<void> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const doc = await tx.contractorDocument.findUnique({
          where: { id: documentId },
          include: { contractorProfile: { select: { companyId: true } } },
        });
        if (!doc) {
          throw new NotFoundException(`Document ${documentId} not found`);
        }
        assertInScope(
          caller,
          { companyId: doc.contractorProfile.companyId },
          `Document ${documentId}`,
        );
        await tx.contractorDocument.delete({ where: { id: documentId } });
        return doc;
      },
    );

    // Blob removal after the row is gone, and not inside the transaction: object
    // storage cannot participate in a Postgres rollback, so deleting first would
    // orphan the file if the transaction failed. `delete` is idempotent, so a failure
    // here leaves an unreferenced blob rather than a row pointing at nothing.
    await this.storage.delete(removed.fileRef);

    await this.auditLog.record({
      entityType: AuditEntityType.CONTRACTOR_DOCUMENT,
      action: AuditAction.DELETE,
      entityId: documentId,
      accountId: caller.id,
      companyId: removed.contractorProfile.companyId,
      ipAddress,
    });
  }

  private toView(profile: Record<string, unknown>): Record<string, unknown> {
    const vendor = profile.vendor as
      | { name: string; code: string; type: string }
      | undefined;
    const counts = profile._count as { documents: number } | undefined;
    const {
      vendor: _v,
      _count: _c,
      ...rest
    } = profile as Record<string, unknown> & {
      vendor?: unknown;
      _count?: unknown;
    };
    return {
      ...rest,
      vendorName: vendor?.name ?? null,
      vendorCode: vendor?.code ?? null,
      vendorType: vendor?.type ?? null,
      ...(counts ? { documentCount: counts.documents } : {}),
    };
  }
}
