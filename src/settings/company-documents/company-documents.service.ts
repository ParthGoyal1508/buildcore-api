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
  scopeForCode,
} from '../document-kinds';
import { DEFAULT_DOCUMENT_TYPES } from '../reference-data/default-document-types';
import {
  DOCUMENT_EXPIRY_REQUIRED,
  DOCUMENT_KIND_NOT_REQUIRED,
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
  /**
   * Documents filed against a kind outside the required set (FR-001a).
   *
   * A separate list rather than more entries in `present`, because `present` is what
   * the completeness figure counts: merging them would let filing an unrelated trade
   * licence move a compliance number, which answers a different question than the one
   * the screen is asking.
   */
  supplementary: CompanyDocumentView[];
  /**
   * Every kind this company could file against — whether or not it holds one yet.
   *
   * Without this the upload control can only be built from kinds that already have a
   * document, so a newly defined type is impossible to file the FIRST document against:
   * it is in no list, so it is in no dropdown, so it never gets a document, so it stays
   * in no list. `present` and `supplementary` answer "what do we hold"; this answers
   * "what may be uploaded", and they are not the same question.
   *
   * Free: `completenessFor` already fetches every type for the company in its one query.
   * The alternative — the client calling `settings/document-types` — is guarded by
   * `EMPLOYEES`, so an administrator holding only `COMPANY_SETTINGS` would get a 403 and
   * an empty dropdown on a screen they are entitled to use.
   */
  availableKinds: {
    documentTypeId: string;
    code: string;
    name: string;
    hasExpiry: boolean;
    isRestricted: boolean;
    isRequired: boolean;
  }[];
}

/** The employee file's codes, for `scopeForCode`. Derived, never restated. */
const DEFAULT_DOCUMENT_TYPE_CODES = DEFAULT_DOCUMENT_TYPES.map((d) => d.code);

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
   *
   * The query is **not** filtered to the required codes (FR-001a, plan D1). It was, and
   * that is why a document filed against any other kind was stored and then never seen
   * again — worse than refusing the upload, because the file exists and nothing says so.
   * Every type the company has defined is fetched and the split into required and
   * supplementary happens below. That is the simpler query, not a more complex one: it
   * stays ONE statement whatever the company has defined, which is the property T016
   * asserts and the only one that would rot quietly.
   */
  async completenessFor(
    ctx: RlsContext,
    companyId: string,
  ): Promise<CompanyDocumentCompleteness> {
    const types = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.documentType.findMany({
        where: { companyId },
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

    // Everything else the company actually holds. Required codes are compared
    // case-insensitively here exactly as they are above, so a type recorded as `gst`
    // cannot be counted in `present` and listed again as supplementary.
    const requiredCodes = new Set(
      REQUIRED_COMPANY_DOCUMENT_CODES.map((c) => c.toUpperCase()),
    );
    const supplementary: CompanyDocumentView[] = [];
    for (const type of types) {
      if (requiredCodes.has(type.code.toUpperCase())) continue;
      const doc = type.companyDocuments[0];
      if (doc) supplementary.push(this.toView(doc, type));
    }
    supplementary.sort((a, b) => a.name.localeCompare(b.name));

    // Built from the same rows, so it costs nothing beyond the mapping. Inactive types
    // are excluded: deactivating a kind is how an administrator retires it, and offering
    // it in the upload control would make that switch do nothing visible.
    const availableKinds = types
      // The organisation's papers only (017 amendment). An employee's marksheet is not
      // something a company files against itself, and offering it here was the other
      // half of the same mixing that put GST in the Employee Setup list.
      .filter((t) => t.isActive && t.scope !== 'employee')
      .map((t) => ({
        documentTypeId: t.id,
        code: t.code,
        name: t.name,
        hasExpiry: t.hasExpiry,
        isRestricted: t.isRestricted,
        isRequired: requiredCodes.has(t.code.toUpperCase()),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const horizon = new Date();
    horizon.setDate(
      horizon.getDate() + config().documents.expiryReminderLeadDays,
    );
    // Over BOTH lists, not just `present` (FR-001a). `CompanyDocumentExpiryRule` has
    // never filtered by kind — it reminds on every current document with a date — so a
    // required-only warning list here would leave the dashboard warning about a lapsing
    // trade licence that the documents screen itself shows as fine. `expiringSoon` is a
    // warning, not the compliance count; D2's rule is that supplementary kinds must not
    // move `present`/`missing`, and they do not.
    const expiringSoon = [...present, ...supplementary].filter(
      (d) => d.expiresAt !== null && d.expiresAt <= horizon,
    );

    return { present, missing, expiringSoon, supplementary, availableKinds };
  }

  /**
   * Brings a required kind's `DocumentType` into existence for this company (FR-003a).
   *
   * Every field of the created row comes from `REQUIRED_COMPANY_DOCUMENT_KINDS`
   * (Principle III) — **the caller supplies only which code**. That is the whole reason
   * this route can sit behind `COMPANY_SETTINGS` while general document-type creation
   * sits behind `EMPLOYEES`: an administrator here cannot invent a type, only materialise
   * one this feature already declares required. A code outside that set is refused, and
   * `company-documents.service.spec.ts` asserts that refusal rather than trusting it.
   *
   * Idempotent. Two administrators clicking "Define and upload" at the same moment should
   * produce one type and two successful responses, not one success and a unique violation
   * on `(companyId, code)`.
   */
  async defineRequiredKind(
    ctx: RlsContext,
    companyId: string,
    code: string,
    actor: { userId: string; ipAddress: string },
  ): Promise<{ documentTypeId: string; code: string; name: string }> {
    const normalised = code.trim().toUpperCase();
    const kind = REQUIRED_COMPANY_DOCUMENT_KINDS.find(
      (k) => k.code.toUpperCase() === normalised,
    );
    if (!kind) {
      throw new BadRequestException({
        statusCode: 400,
        message:
          `"${code}" is not one of the required company document kinds. This route ` +
          `only brings a declared kind into existence; other document types are ` +
          `defined under Settings → Document Types.`,
        code: DOCUMENT_KIND_NOT_REQUIRED,
      });
    }

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

    await this.audit.record({
      entityType: AuditEntityType.COMPANY,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: {
        documentTypeCode: created.code,
        definedFor: 'company-document',
      },
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

  /**
   * Defines a document kind this company invents for itself (FR-001b).
   *
   * Scoped to `company` unconditionally. That single fact is what lets this sit behind
   * `COMPANY_SETTINGS` rather than the `EMPLOYEES` permission guarding
   * `settings/document-types`: a kind created here can never appear in the employee file,
   * so this is not general document-type creation reached through a second door.
   *
   * The code is derived rather than asked for. It is an internal identifier that only
   * has to be unique within the company, and an administrator holding a certificate has
   * no basis on which to invent one. Collisions get a numeric suffix rather than a
   * refusal — two kinds a person would name "Insurance" are a real thing, and making
   * somebody rename their second one to satisfy a column they cannot see is the kind of
   * refusal that teaches people the software is against them.
   */
  async createCompanyKind(
    ctx: RlsContext,
    companyId: string,
    input: { name: string; hasExpiry?: boolean; needsNumber?: boolean },
    actor: { userId: string; ipAddress: string },
  ): Promise<{ documentTypeId: string; code: string; name: string }> {
    const name = input.name.trim();
    const base =
      name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'DOCUMENT';

    const created = await withRlsContext(this.prisma, ctx, async (tx) => {
      const taken = new Set(
        (
          await tx.documentType.findMany({
            where: { companyId, code: { startsWith: base } },
            select: { code: true },
          })
        ).map((t) => t.code),
      );
      let code = base;
      for (let n = 2; taken.has(code); n++) code = `${base}_${n}`;

      return tx.documentType.create({
        data: {
          companyId,
          code,
          name,
          isMandatory: false,
          hasExpiry: input.hasExpiry ?? false,
          needsNumber: input.needsNumber ?? false,
          // Never from the request. FR-024's restriction is a rule about regulated
          // personal data settled in configuration, not a checkbox on a creation form.
          isRestricted: false,
          scope: 'company',
          sortOrder: 600,
        },
        select: { id: true, code: true, name: true },
      });
    });

    await this.audit.record({
      entityType: AuditEntityType.COMPANY,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: { documentTypeCode: created.code, scope: 'company' },
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
