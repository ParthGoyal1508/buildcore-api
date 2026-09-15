import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import config from '../../common/configs/config';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import {
  REQUIRED_COMPANY_DOCUMENT_CODES,
  REQUIRED_COMPANY_DOCUMENT_KINDS,
} from '../document-kinds';
import {
  DOCUMENT_EXPIRY_REQUIRED,
  DOCUMENT_TYPE_NOT_FOUND,
} from './company-document-error-codes';

/** One stored document, as the interface renders it. */
export interface CompanyDocumentView {
  id: string;
  documentTypeId: string;
  code: string;
  name: string;
  isRestricted: boolean;
  documentNumber: string | null;
  expiresAt: Date | null;
  uploadedAt: Date;
  /** True when this is the version that counts as present compliance (FR-006). */
  isCurrent: boolean;
}

/** A required kind this company does not hold (FR-003). */
export interface MissingKind {
  code: string;
  label: string;
  /** Null when the company has never even defined a `DocumentType` for this code. */
  documentTypeId: string | null;
}

export interface CompanyDocumentCompleteness {
  present: CompanyDocumentView[];
  missing: MissingKind[];
  expiringSoon: CompanyDocumentView[];
}

@Injectable()
export class CompanyDocumentsService {
  private readonly logger = new Logger(CompanyDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Which required kinds this company holds and which it lacks (FR-003).
   *
   * **One query, and the unit test asserts that rather than the result** (T016).
   * The obvious implementation asks "do we have a GST certificate?" once per required
   * kind — eight queries that look fine in development and are still eight in production.
   * Fetching the types with their current documents joined answers all eight at once.
   *
   * `DocumentType` is per company, so a kind the company never defined a type for is
   * reported missing with a null `documentTypeId`: that is the honest answer to "do you
   * hold a GST certificate?" and it tells the interface it must create the type first.
   */
  async completenessFor(
    ctx: RlsContext,
    companyId: string,
  ): Promise<CompanyDocumentCompleteness> {
    const types = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.documentType.findMany({
        where: { companyId, code: { in: REQUIRED_COMPANY_DOCUMENT_CODES } },
        include: {
          // Only the CURRENT document per type. Superseded ones are history, not
          // evidence of present compliance, and the partial unique index guarantees
          // at most one row here.
          companyDocuments: { where: { isCurrent: true } },
        },
      }),
    );

    const byCode = new Map(types.map((t) => [t.code.toUpperCase(), t]));
    const present: CompanyDocumentView[] = [];
    const missing: MissingKind[] = [];

    for (const kind of REQUIRED_COMPANY_DOCUMENT_KINDS) {
      const type = byCode.get(kind.code.toUpperCase());
      const doc = type?.companyDocuments[0];
      if (type && doc) {
        present.push(this.toView(doc, type));
      } else {
        missing.push({
          code: kind.code,
          label: kind.label,
          documentTypeId: type?.id ?? null,
        });
      }
    }

    const horizon = new Date();
    horizon.setDate(
      horizon.getDate() + config().documents.expiryReminderLeadDays,
    );
    const expiringSoon = present.filter(
      (d) => d.expiresAt !== null && d.expiresAt <= horizon,
    );

    return { present, missing, expiringSoon };
  }

  /**
   * Stores a document, superseding whatever it replaces (FR-001, FR-004, FR-006).
   *
   * The previous current document is not deleted — it keeps its row **and its stored
   * file**, and gains nothing except a successor pointing at it. A retained record whose
   * blob was deleted is not a retained document.
   */
  async upload(
    ctx: RlsContext,
    input: {
      companyId: string;
      documentTypeId: string;
      data: Buffer;
      contentType: string;
      documentNumber?: string | null;
      expiresAt?: string | null;
    },
    actor: { userId: string; ipAddress: string },
  ): Promise<CompanyDocumentView> {
    const type = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.documentType.findFirst({
        where: { id: input.documentTypeId, companyId: input.companyId },
      }),
    );
    if (!type) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'No document type of that id exists for this company.',
        code: DOCUMENT_TYPE_NOT_FOUND,
      });
    }

    // FR-004. Asked for before the bytes are stored, so a refusal leaves nothing behind.
    if (type.hasExpiry && !input.expiresAt) {
      throw new BadRequestException({
        statusCode: 400,
        message:
          `"${type.name}" expires, so an expiry date is required. Without one this ` +
          `document would sit in the system looking present and never warn anybody ` +
          `that it had lapsed.`,
        code: DOCUMENT_EXPIRY_REQUIRED,
      });
    }

    const fileRef = await this.storage.put(
      `company-documents/${input.companyId}`,
      input.data,
      input.contentType,
    );

    // Read and write inside ONE `withRlsContext`, which is itself a transaction — so the
    // outgoing version's demotion and the incoming one's insert cannot be observed apart,
    // and a concurrent upload cannot slip between them and leave two rows current.
    const { created, superseded } = await withRlsContext(
      this.prisma,
      ctx,
      async (tx) => {
        const current = await tx.companyDocument.findFirst({
          where: {
            companyId: input.companyId,
            documentTypeId: type.id,
            isCurrent: true,
          },
        });

        // Demote first, then insert. The order is forced by the partial unique index:
        // two rows may not be current at once, so the outgoing version must step down
        // before the incoming one takes the slot. It keeps its row AND its stored file —
        // a retained record pointing at a deleted blob is not a retained document.
        if (current) {
          await tx.companyDocument.update({
            where: { id: current.id },
            data: { isCurrent: false },
          });
        }

        const row = await tx.companyDocument.create({
          data: {
            companyId: input.companyId,
            documentTypeId: type.id,
            fileRef,
            documentNumber: input.documentNumber ?? null,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            uploadedByUserId: actor.userId,
            isCurrent: true,
            supersedesId: current?.id ?? null,
          },
        });
        return { created: row, superseded: current?.id ?? null };
      },
    );

    await this.audit.record({
      entityType: AuditEntityType.COMPANY,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: {
        documentTypeCode: type.code,
        superseded,
        isRestricted: type.isRestricted,
      },
      accountId: actor.userId,
      companyId: input.companyId,
      ipAddress: actor.ipAddress,
    });

    return this.toView(created, type);
  }

  /**
   * Retrieves the bytes, recording the retrieval **before** returning them (FR-024).
   *
   * Written before rather than after deliberately: an audit entry that only appears once
   * the transfer succeeded cannot describe the retrieval that failed halfway, and for a
   * restricted kind the attempt is the thing worth knowing about.
   *
   * The entry goes through `AuditLogService`, which is write-only by a ratified 001
   * clarification; it is read back through feature 004's Activity Log, not through an
   * endpoint this module adds.
   */
  async download(
    ctx: RlsContext,
    companyId: string,
    documentId: string,
    actor: { userId: string; ipAddress: string },
  ): Promise<{ data: Buffer; view: CompanyDocumentView }> {
    const doc = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.companyDocument.findFirst({
        where: { id: documentId, companyId },
        include: { documentType: true },
      }),
    );
    if (!doc) throw new NotFoundException('Document not found.');

    await this.audit.record({
      entityType: AuditEntityType.COMPANY,
      action: AuditAction.READ,
      entityId: doc.id,
      changes: {
        documentTypeCode: doc.documentType.code,
        isRestricted: doc.documentType.isRestricted,
        retrieved: true,
      },
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });

    const data = await this.storage.get(doc.fileRef);
    return { data, view: this.toView(doc, doc.documentType) };
  }

  /** Every version of one kind, newest first — the history FR-006 preserves. */
  async historyFor(
    ctx: RlsContext,
    companyId: string,
    documentTypeId: string,
  ): Promise<CompanyDocumentView[]> {
    const docs = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.companyDocument.findMany({
        where: { companyId, documentTypeId },
        include: { documentType: true },
        orderBy: { uploadedAt: 'desc' },
      }),
    );
    return docs.map((d) => this.toView(d, d.documentType));
  }

  /**
   * Purges superseded versions of restricted kinds past their retention (FR-006a).
   *
   * FR-006 says retain; FR-006a bounds that for regulated data. Aadhaar is the only
   * restricted kind today, and keeping every superseded scan of it forever is a liability
   * that grows without anybody deciding it should.
   *
   * Returns how many were removed so the caller can log it. Runs as a system sweep, so
   * the caller supplies the context — this method does not assume super-admin.
   */
  async purgeExpiredRestricted(ctx: RlsContext): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(
      cutoff.getDate() - config().documents.restrictedRetentionDays,
    );

    const stale = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.companyDocument.findMany({
        where: {
          isCurrent: false,
          uploadedAt: { lt: cutoff },
          documentType: { isRestricted: true },
        },
        select: { id: true, fileRef: true },
      }),
    );
    if (stale.length === 0) return 0;

    // Blob first, row second. The other order can leave a row pointing at nothing, which
    // reads as data loss; this order can at worst orphan a blob, which is recoverable.
    await this.storage.deleteMany(stale.map((d) => d.fileRef));
    await withRlsContext(this.prisma, ctx, (tx) =>
      tx.companyDocument.deleteMany({
        where: { id: { in: stale.map((d) => d.id) } },
      }),
    );

    this.logger.log(
      `Purged ${stale.length} superseded restricted document(s) older than ` +
        `${config().documents.restrictedRetentionDays} days.`,
    );
    return stale.length;
  }

  private toView(
    doc: {
      id: string;
      documentTypeId: string;
      documentNumber: string | null;
      expiresAt: Date | null;
      uploadedAt: Date;
      isCurrent: boolean;
    },
    type: {
      code: string;
      name: string;
      isRestricted: boolean;
    },
  ): CompanyDocumentView {
    return {
      id: doc.id,
      documentTypeId: doc.documentTypeId,
      code: type.code,
      name: type.name,
      isRestricted: type.isRestricted,
      documentNumber: doc.documentNumber,
      expiresAt: doc.expiresAt,
      uploadedAt: doc.uploadedAt,
      isCurrent: doc.isCurrent,
    };
  }
}
