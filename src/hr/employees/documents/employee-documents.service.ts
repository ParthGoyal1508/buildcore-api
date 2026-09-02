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
  if (days <= warningDays) return { state: 'expiring_soon', daysToExpiry: days };
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
   * Re-uploading the same type replaces the reference rather than versioning it —
   * data-model.md is explicit that historical replacement is not tracked. The old
   * blob is deleted after the row is updated, so a storage failure cannot leave the
   * row pointing at a deleted file.
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
      throw new BadRequestException(
        `${type.name} requires a document number.`,
      );
    }
    if (type.hasExpiry && !dto.expiresAt) {
      throw new BadRequestException(`${type.name} requires an expiry date.`);
    }

    // TODO(VIRUS_SCAN): uploads are stored unscanned (research.md §10). The scan
    // belongs between decoding and `storage.put`, and is deferred rather than
    // faked — a no-op "scanner" would be worse than an explicit gap, because it
    // reads as protection that is not there.
    const buffer = Buffer.from(dto.file, 'base64');
    if (buffer.length === 0) {
      throw new BadRequestException('file must be non-empty base64 content.');
    }
    const fileRef = await this.storage.put(
      newStorageRef('employee-documents'),
      buffer,
      dto.contentType,
    );

    const existing = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employeeDocument.findUnique({
        where: {
          employeeId_documentTypeId: {
            employeeId,
            documentTypeId: dto.documentTypeId,
          },
        },
        select: { id: true, fileRef: true },
      }),
    );

    const saved = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employeeDocument.upsert({
        where: {
          employeeId_documentTypeId: {
            employeeId,
            documentTypeId: dto.documentTypeId,
          },
        },
        create: {
          employeeId,
          documentTypeId: dto.documentTypeId,
          fileRef,
          documentNumber: dto.documentNumber?.trim() ?? null,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          uploadedByUserId: caller.userId,
        },
        update: {
          fileRef,
          documentNumber: dto.documentNumber?.trim() ?? null,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          uploadedByUserId: caller.userId,
          uploadedAt: new Date(),
        },
      }),
    );

    // Only once the row certainly points at the new blob.
    if (existing?.fileRef && existing.fileRef !== fileRef) {
      await this.storage.delete(existing.fileRef);
    }

    await this.auditLog.record({
      entityType: AuditEntityType.EMPLOYEE_DOCUMENT,
      action: existing ? AuditAction.UPDATE : AuditAction.CREATE,
      entityId: saved.id,
      changes: { documentTypeId: dto.documentTypeId },
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
      }),
    );

    const types = await this.documentTypes.listForCompany(employee.companyId);
    const byId = new Map(types.map((t) => [t.id, t]));

    const { missing } = await this.documentTypes.hasMissingMandatoryDocs(
      employee.companyId,
      rows.map((r) => r.documentTypeId),
    );
    const mandatoryTotal = types.filter((t) => t.isMandatory && t.isActive)
      .length;

    return {
      documents: rows.map((r) => this.toView(r, byId.get(r.documentTypeId))),
      missingMandatory: missing.map((m) => ({ id: m.id, name: m.name })),
      mandatoryTotal,
      mandatoryHeld: mandatoryTotal - missing.length,
    };
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
      throw new NotFoundException(
        'Document type not found for this company.',
      );
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
      expiresAt: row.expiresAt ? row.expiresAt.toISOString().slice(0, 10) : null,
      expiryState: state,
      daysToExpiry,
      uploadedAt: row.uploadedAt,
    };
  }
}
