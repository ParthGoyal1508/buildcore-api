import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, AuditEntityType, DocumentType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../../auth/audit-log.service';
import type { HrPayrollConfig } from '../../../common/configs/config.interface';
import { withRlsContext } from '../../../common/prisma/rls-context';
import {
  StorageService,
  newStorageRef,
} from '../../../common/storage/storage.service';
import { describeStoredFile } from '../../../common/storage/file-type';
import {
  assertAllowedFileType,
  compressImageUpload,
  decodeBase64Upload,
  DOCUMENT_TYPES,
} from '../../../common/uploads';
import { DocumentTypesService } from '../../../settings/reference-data/document-types.service';
import type { Caller } from '../../biometrics/face-enrolment.service';
import type { UploadEmployeeDocumentDto } from './dto/upload-document.dto';

/** Expiry state a document is reported in. */
export type DocumentExpiryState = 'valid' | 'expiring_soon' | 'expired';

export interface EmployeeDocumentView {
  id: string;
  documentTypeId: string;
  documentTypeName: string;
  isMandatory: boolean;
  documentNumber: string | null;
  expiresAt: string | null;
  expiryState: DocumentExpiryState | null;
  daysToExpiry: number | null;
  uploadedAt: Date;
  /** What the file is (036 F15) — null for documents filed before these were recorded. */
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Earlier uploads this one replaced, newest first (036 F15). */
  previousVersions: EmployeeDocumentVersionView[];
}

/** A superseded upload, kept rather than deleted (036 F15). */
export interface EmployeeDocumentVersionView {
  id: string;
  documentNumber: string | null;
  expiresAt: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedAt: Date;
  replacedAt: Date;
}

/**
 * Pure expiry classification, separated from the service so it can be tested
 * without a database (T029).
 *
 * `daysToExpiry` is negative once past — callers sort on it and want expired
 * documents to come first naturally, which a clamped-at-zero value would prevent.
 */
export function classifyExpiry(
  expiresAt: Date | null,
  today: Date,
  warningDays: number,
): { state: DocumentExpiryState | null; daysToExpiry: number | null } {
  if (!expiresAt) return { state: null, daysToExpiry: null };

  const MS_PER_DAY = 86_400_000;
  const startOfDay = (d: Date) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round(
    (startOfDay(expiresAt) - startOfDay(today)) / MS_PER_DAY,
  );

  if (days < 0) return { state: 'expired', daysToExpiry: days };
  if (days <= warningDays)
    return { state: 'expiring_soon', daysToExpiry: days };
  return { state: 'valid', daysToExpiry: days };
}

/**
 * Employee document storage and the mandatory-document gate (005 US2).
 *
 * The *policy* — which types are mandatory, whether one needs a number or an
 * expiry — belongs to Settings' Document Type master (002) and is read through
 * `DocumentTypesService`. This service owns only the stored documents themselves.
 */
@Injectable()
export class EmployeeDocumentsService {
  private readonly warningDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly documentTypes: DocumentTypesService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
  ) {
    this.warningDays =
      configService.get<HrPayrollConfig>('hrPayroll').documentExpiryWarningDays;
  }

  /**
   * Stores a document against an employee.
   *
   * Re-uploading the same type replaces the current document, and since 036 F15 the one it
   * replaces is **kept** as an `EmployeeDocumentVersion`, file and all. It used to be deleted for
   * good (data-model.md said historical replacement was not tracked), so a passport renewed over
   * the wrong one could not be recovered. The move and the update are one transaction, so a
   * failure cannot lose the old version or leave two current ones.
   *
   * The file goes through the shared upload helpers (036 B4/B5): 413 over the size limit, 415 for
   * anything not a PDF, photo or Office file, decided by its bytes; photos are compressed; and the
   * **detected** type is stored, not the one the browser declared.
   */
  async upload(
    caller: Caller,
    employeeId: string,
    dto: UploadEmployeeDocumentDto,
  ): Promise<EmployeeDocumentView> {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: employeeId },
        select: { id: true, companyId: true },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');

    const type = await this.requireDocumentType(
      employee.companyId,
      dto.documentTypeId,
    );

    // The type's own flags decide what this upload must carry — the rules live in
    // Settings, so a company that stops requiring a number does not need a code
    // change here.
    if (type.needsNumber && !dto.documentNumber?.trim()) {
      throw new BadRequestException(`${type.name} requires a document number.`);
    }
    if (type.hasExpiry && !dto.expiresAt) {
      throw new BadRequestException(`${type.name} requires an expiry date.`);
    }

    // TODO(VIRUS_SCAN): uploads are stored unscanned (research.md §10). The scan
    // belongs between decoding and `storage.put`, and is deferred rather than
    // faked — a no-op "scanner" would be worse than an explicit gap, because it
    // reads as protection that is not there.
    const bytes = decodeBase64Upload(dto.file, type.name);
    const detected = assertAllowedFileType(bytes, DOCUMENT_TYPES, type.name);
    const image = await compressImageUpload(bytes, detected.contentType);
    const stored = image?.main.data ?? bytes;
    const mimeType = image?.main.contentType ?? detected.contentType;
    const fileRef = await this.storage.put(
      newStorageRef('employee-documents'),
      stored,
      mimeType,
    );
    const metadata = {
      fileRef,
      fileName: cleanFileName(dto.fileName),
      mimeType,
      sizeBytes: stored.length,
      documentNumber: dto.documentNumber?.trim() || null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      uploadedByUserId: caller.userId,
    };

    // A restricted type (Aadhaar) is regulated personal data, and 017 FR-006a says superseded
    // copies of it are not retained: its replaced file is still deleted, as before 036.
    const keepPrevious = !type.isRestricted;
    const { saved, replaced, discardRef } = await withRlsContext(
      this.prisma,
      caller.rls,
      async (tx) => {
        const existing = await tx.employeeDocument.findUnique({
          where: {
            employeeId_documentTypeId: {
              employeeId,
              documentTypeId: dto.documentTypeId,
            },
          },
        });
        if (!existing) {
          const created = await tx.employeeDocument.create({
            data: {
              employeeId,
              documentTypeId: dto.documentTypeId,
              ...metadata,
            },
            include: { versions: { orderBy: { replacedAt: 'desc' } } },
          });
          return { saved: created, replaced: false, discardRef: null };
        }
        if (!keepPrevious) {
          const updated = await tx.employeeDocument.update({
            where: { id: existing.id },
            data: { ...metadata, uploadedAt: new Date() },
            include: { versions: { orderBy: { replacedAt: 'desc' } } },
          });
          return {
            saved: updated,
            replaced: true,
            discardRef: existing.fileRef,
          };
        }
        await tx.employeeDocumentVersion.create({
          data: {
            documentId: existing.id,
            employeeId,
            fileRef: existing.fileRef,
            fileName: existing.fileName,
            mimeType: existing.mimeType,
            sizeBytes: existing.sizeBytes,
            documentNumber: existing.documentNumber,
            expiresAt: existing.expiresAt,
            uploadedByUserId: existing.uploadedByUserId,
            uploadedAt: existing.uploadedAt,
            replacedByUserId: caller.userId,
          },
        });
        const updated = await tx.employeeDocument.update({
          where: { id: existing.id },
          data: { ...metadata, uploadedAt: new Date() },
          include: { versions: { orderBy: { replacedAt: 'desc' } } },
        });
        return { saved: updated, replaced: true, discardRef: null };
      },
    );

    // Only once the row certainly points at the new blob.
    if (discardRef && discardRef !== fileRef) {
      await this.storage.delete(discardRef);
    }

    await this.auditLog.record({
      entityType: AuditEntityType.EMPLOYEE_DOCUMENT,
      action: replaced ? AuditAction.UPDATE : AuditAction.CREATE,
      entityId: saved.id,
      changes: {
        documentTypeId: dto.documentTypeId,
        ...(replaced ? { previousVersionKept: keepPrevious } : {}),
      },
      accountId: caller.userId,
      companyId: employee.companyId,
      ipAddress: caller.ipAddress,
    });

    return this.toView(saved, type);
  }

  /**
   * An employee's documents plus the mandatory-completion summary the Documents
   * tab's progress bar renders.
   */
  async list(
    caller: Caller,
    employeeId: string,
  ): Promise<{
    documents: EmployeeDocumentView[];
    missingMandatory: { id: string; name: string }[];
    mandatoryTotal: number;
    mandatoryHeld: number;
  }> {
    const employee = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findFirst({
        where: { id: employeeId },
        select: { id: true, companyId: true },
      }),
    );
    if (!employee) throw new NotFoundException('Employee not found');

    const rows = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employeeDocument.findMany({
        where: { employeeId },
        orderBy: { uploadedAt: 'desc' },
        include: { versions: { orderBy: { replacedAt: 'desc' } } },
      }),
    );

    const types = await this.documentTypes.listForCompany(employee.companyId);
    const byId = new Map(types.map((t) => [t.id, t]));

    const { missing } = await this.documentTypes.hasMissingMandatoryDocs(
      employee.companyId,
      rows.map((r) => r.documentTypeId),
    );
    const mandatoryTotal = types.filter(
      (t) => t.isMandatory && t.isActive,
    ).length;

    return {
      documents: rows.map((r) => this.toView(r, byId.get(r.documentTypeId))),
      missingMandatory: missing.map((m) => ({ id: m.id, name: m.name })),
      mandatoryTotal,
      mandatoryHeld: mandatoryTotal - missing.length,
    };
  }

  /**
   * The bytes of a document — its current upload, or one it replaced when `versionId` is given
   * (036 F15). There was no way to open an uploaded document at all before this.
   *
   * Every retrieval is audited **before** the bytes are returned, as company documents do: an
   * identity document is personal data, and the attempt is the thing worth knowing about.
   */
  async file(
    caller: Caller,
    employeeId: string,
    documentId: string,
    versionId?: string,
  ): Promise<{ data: Buffer; filename: string; contentType: string }> {
    const doc = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employeeDocument.findFirst({
        where: { id: documentId, employeeId },
        include: {
          employee: { select: { companyId: true, employeeCode: true } },
        },
      }),
    );
    if (!doc) throw new NotFoundException('Document not found');
    let source: {
      fileRef: string;
      fileName: string | null;
      mimeType: string | null;
    } = doc;
    if (versionId) {
      const version = await withRlsContext(this.prisma, caller.rls, (tx) =>
        tx.employeeDocumentVersion.findFirst({
          where: { id: versionId, documentId },
        }),
      );
      if (!version) throw new NotFoundException('Document version not found');
      source = version;
    }

    await this.auditLog.record({
      entityType: AuditEntityType.EMPLOYEE_DOCUMENT,
      action: AuditAction.READ,
      entityId: doc.id,
      changes: versionId ? { versionId } : {},
      accountId: caller.userId,
      companyId: doc.employee.companyId,
      ipAddress: caller.ipAddress,
    });

    const data = await this.storage.get(source.fileRef);
    const types = await this.documentTypes.listForCompany(
      doc.employee.companyId,
    );
    const typeName =
      types.find((t) => t.id === doc.documentTypeId)?.name ?? 'Document';
    const { filename, contentType } = describeStoredFile({
      bytes: data,
      storedName: source.fileName,
      storedType: source.mimeType,
      fallbackName: `${doc.employee.employeeCode} ${typeName}`
        .replace(/[^A-Za-z0-9 _.-]/g, '')
        .trim(),
    });
    return { data, filename, contentType };
  }

  /**
   * The attendance gate (spec FR-005, 002 FR-021).
   *
   * Exported so both the self-service punch path (003) and the admin Mark
   * Attendance path (US3) can call the same check — one gate, two callers, rather
   * than two implementations that drift.
   */
  async assertMandatoryDocsComplete(
    employeeId: string,
    companyId: string,
  ): Promise<void> {
    const held = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.employeeDocument.findMany({
          where: { employeeId },
          select: { documentTypeId: true },
        }),
    );
    const { missing } = await this.documentTypes.hasMissingMandatoryDocs(
      companyId,
      held.map((h) => h.documentTypeId),
    );
    if (missing.length > 0) {
      throw new BadRequestException(
        `Attendance cannot be marked: missing mandatory document(s) — ${missing
          .map((m) => m.name)
          .join(', ')}.`,
      );
    }
  }

  private async requireDocumentType(
    companyId: string,
    documentTypeId: string,
  ): Promise<DocumentType> {
    const types = await this.documentTypes.listForCompany(companyId);
    const type = types.find((t) => t.id === documentTypeId);
    if (!type) {
      throw new NotFoundException('Document type not found for this company.');
    }
    return type;
  }

  private toView(
    row: {
      id: string;
      documentTypeId: string;
      documentNumber: string | null;
      expiresAt: Date | null;
      uploadedAt: Date;
      fileName?: string | null;
      mimeType?: string | null;
      sizeBytes?: number | null;
      versions?: {
        id: string;
        documentNumber: string | null;
        expiresAt: Date | null;
        fileName: string | null;
        mimeType: string | null;
        sizeBytes: number | null;
        uploadedAt: Date;
        replacedAt: Date;
      }[];
    },
    type?: DocumentType,
  ): EmployeeDocumentView {
    const { state, daysToExpiry } = classifyExpiry(
      row.expiresAt,
      new Date(),
      this.warningDays,
    );
    return {
      id: row.id,
      documentTypeId: row.documentTypeId,
      documentTypeName: type?.name ?? 'Unknown document type',
      isMandatory: type?.isMandatory ?? false,
      documentNumber: row.documentNumber,
      expiresAt: row.expiresAt
        ? row.expiresAt.toISOString().slice(0, 10)
        : null,
      expiryState: state,
      daysToExpiry,
      uploadedAt: row.uploadedAt,
      fileName: row.fileName ?? null,
      mimeType: row.mimeType ?? null,
      sizeBytes: row.sizeBytes ?? null,
      previousVersions: (row.versions ?? []).map((v) => ({
        id: v.id,
        documentNumber: v.documentNumber,
        expiresAt: v.expiresAt ? v.expiresAt.toISOString().slice(0, 10) : null,
        fileName: v.fileName,
        mimeType: v.mimeType,
        sizeBytes: v.sizeBytes,
        uploadedAt: v.uploadedAt,
        replacedAt: v.replacedAt,
      })),
    };
  }
}

/**
 * The uploader's file name, as something safe to keep and later serve: path parts dropped
 * (a browser on Windows can send `C:\fakepath\scan.pdf`), control characters removed, capped.
 * `contentDispositionFor` does the header-safety at serve time; this only keeps the column sane.
 */
function cleanFileName(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned ? cleaned.slice(0, 255) : null;
}
