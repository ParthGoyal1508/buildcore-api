import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, AuditEntityType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { ACTOR_NAME_SELECT, actorNameOf } from '../../common/actor-name';
import { AuditLogService } from '../../auth/audit-log.service';
import { DocumentsConfig } from '../../common/configs/config.interface';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { describeStoredFile } from '../../common/storage/file-type';
import { StorageService } from '../../common/storage/storage.service';
import { REQUIRED_PROJECT_DOCUMENT_KINDS } from '../../settings/document-kinds';
import { DocumentTypesService } from '../../settings/reference-data/document-types.service';
import {
  PROJECT_DOCUMENTS_MANDATORY_MISSING,
  PROJECT_DOCUMENT_KIND_NOT_DEFINED,
  PROJECT_STAGED_DOCUMENT_UNKNOWN,
  PROJECT_DOCUMENT_KIND_NOT_REQUIRED,
  PROJECT_DOCUMENT_TYPE_UNKNOWN,
} from './project-document-error-codes';
import { SetProjectDocumentRequirementsDto } from './dto/project-document-requirement.dto';

/** One configured requirement, with the words a person reads. */
export interface ProjectDocumentRequirementView {
  documentTypeId: string;
  code: string;
  name: string;
  isMandatory: boolean;
}

export interface ProjectDocumentRequirementSet {
  requirements: ProjectDocumentRequirementView[];
  /**
   * True when this company has configured nothing and the FR-007 shipped set is in
   * force. Reported rather than hidden: "you are using the defaults" and "you chose
   * exactly these six" are different facts and an administrator deciding whether to
   * edit them needs to know which one they are looking at.
   */
  usingDefaults: boolean;
  /**
   * FR-007 codes the company has no `DocumentType` for, so they cannot be required yet.
   *
   * Named rather than silently dropped. Without this a company missing the `MINING_PERMISSION`
   * type would see a five-kind default set and no indication that a sixth was meant to
   * be there.
   */
  undefinedCodes: string[];
  /**
   * The kinds that MAY be required — the organisation's paperwork this company has
   * defined, whether or not it is currently required (FR-007a).
   *
   * The set was configurable through `PUT` from the day this feature shipped and was
   * unreachable from any interface anyway, because naming a requirement meant knowing a
   * document type's internal identifier. This is the list that makes an editor possible.
   *
   * Scoped to `company | both`: an employee's marksheet is not something a project holds,
   * and offering it would be the same mixing `DocumentType.scope` exists to end.
   */
  availableTypes: {
    documentTypeId: string;
    code: string;
    name: string;
    isRequired: boolean;
  }[];
}

/** How far one project is from fully papered (FR-008). */
export interface ProjectDocumentReadiness {
  /**
   * The **mandatory** set, and only the mandatory set (017 FR-007b).
   *
   * These three figures are already rendered on the portfolio list, so they must not move when the
   * advisory split arrives: a "3 of 5" that silently started counting advisory kinds would change
   * every project's reported readiness without anybody asking for it.
   */
  required: number;
  present: number;
  missingTypeIds: string[];
  /**
   * The advisory set, reported separately (FR-007b).
   *
   * An advisory kind is reported outstanding and never blocks creation. Counting it beside the
   * mandatory figures rather than inside them is what lets a reader tell "we cannot start this
   * project" from "we are still chasing paperwork".
   */
  advisoryRequired: number;
  advisoryPresent: number;
  advisoryMissingTypeIds: string[];
}

@Injectable()
export class ProjectDocumentsService {
  /** 017 FR-009d's window, from configuration rather than a literal (Principle III). */
  private readonly retentionHours: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly documentTypes: DocumentTypesService,
    private readonly audit: AuditLogService,
    private readonly storage: StorageService,
    configService: ConfigService,
  ) {
    this.retentionHours =
      configService.get<DocumentsConfig>(
        'documents',
      ).stagedDocumentRetentionHours;
  }

  /**
   * The required set for this company, with names (FR-007).
   *
   * The names come from `DocumentTypesService.listForCompany` — an exported service
   * method — and are joined in memory. `DocumentType` lives in `settings` and this
   * module may not read it, which is exactly why `ProjectDocumentRequirement.documentTypeId`
   * is a bare string rather than a foreign key (Principle I, research §3).
   */
  async listRequirements(
    ctx: RlsContext,
    companyId: string,
  ): Promise<ProjectDocumentRequirementSet> {
    const [configured, types] = await Promise.all([
      withRlsContext(this.prisma, ctx, (tx) =>
        tx.projectDocumentRequirement.findMany({
          where: { companyId },
          orderBy: { createdAt: 'asc' },
        }),
      ),
      this.documentTypes.listForCompany(companyId),
    ]);

    const byId = new Map(types.map((t) => [t.id, t]));

    if (configured.length > 0) {
      const requirements: ProjectDocumentRequirementView[] = [];
      for (const requirement of configured) {
        const type = byId.get(requirement.documentTypeId);
        // A requirement whose type has since been deleted is dropped rather than
        // rendered nameless: `setRequirements` refuses unknown ids, so reaching this
        // means the type went away afterwards, and a row reading "(unknown) —
        // required" helps nobody.
        if (!type) continue;
        requirements.push({
          documentTypeId: requirement.documentTypeId,
          code: type.code,
          name: type.name,
          isMandatory: requirement.isMandatory,
        });
      }
      return {
        requirements,
        usingDefaults: false,
        undefinedCodes: [],
        availableTypes: this.availableFrom(types, requirements),
      };
    }

    // Nothing configured: the FR-007 shipped set applies. Matched on `code`, because
    // `DocumentType` is per company and the code is what identifies a kind across them.
    const byCode = new Map(types.map((t) => [t.code.toUpperCase(), t]));
    const requirements: ProjectDocumentRequirementView[] = [];
    const undefinedCodes: string[] = [];
    for (const kind of REQUIRED_PROJECT_DOCUMENT_KINDS) {
      const type = byCode.get(kind.code.toUpperCase());
      if (type) {
        requirements.push({
          documentTypeId: type.id,
          code: type.code,
          name: type.name,
          isMandatory: true,
        });
      } else {
        undefinedCodes.push(kind.code);
      }
    }
    return {
      requirements,
      usingDefaults: true,
      undefinedCodes,
      availableTypes: this.availableFrom(types, requirements),
    };
  }

  /**
   * The kinds available to require, from rows `listRequirements` already has.
   *
   * Filtered HERE rather than by narrowing `DocumentTypesService.listForCompany`: `hr`
   * resolves an employee's document types through that same method, and a scope filter
   * there would silently drop rows already attached to employee records. What may be
   * required of a project is this surface's decision, not the master fetch's (plan D5).
   *
   * A mapping over rows in hand, so `listRequirements` still makes the same two calls it
   * always did — the thing a later "let me just fetch the types" refactor would break.
   */
  private availableFrom(
    types: {
      id: string;
      code: string;
      name: string;
      scope: string;
      isActive: boolean;
    }[],
    requirements: ProjectDocumentRequirementView[],
  ): ProjectDocumentRequirementSet['availableTypes'] {
    const required = new Set(requirements.map((r) => r.documentTypeId));
    return types
      .filter((t) => t.isActive && t.scope !== 'employee')
      .map((t) => ({
        documentTypeId: t.id,
        code: t.code,
        name: t.name,
        isRequired: required.has(t.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Materialises a declared PROJECT kind the company has no document type for (FR-007a).
   *
   * The state `undefinedCodes` reports: a kind FR-007 names, which this company cannot
   * require because nothing represents it. Reporting it without offering the one action
   * that resolves it is the gap this closes.
   *
   * Resolved against `REQUIRED_PROJECT_DOCUMENT_KINDS` **here**, by the surface entitled
   * to it. `DocumentTypesService.defineDeclaredKind` validates no code set of its own, so
   * a `SETTINGS` holder reaching this route can materialise a project kind and nothing
   * else — not the company's eight, which live behind `COMPANY_SETTINGS`, and not a kind
   * of their own invention (plan D8).
   */
  async defineRequiredKind(
    ctx: RlsContext,
    companyId: string,
    code: string,
    actor: { userId: string; ipAddress: string },
  ): Promise<{ documentTypeId: string; code: string; name: string }> {
    const normalised = code.trim().toUpperCase();
    const kind = REQUIRED_PROJECT_DOCUMENT_KINDS.find(
      (k) => k.code.toUpperCase() === normalised,
    );
    if (!kind) {
      throw new BadRequestException({
        statusCode: 400,
        message:
          `"${code}" is not one of the required project document kinds. This route ` +
          `only brings a declared kind into existence.`,
        code: PROJECT_DOCUMENT_KIND_NOT_REQUIRED,
      });
    }
    return this.documentTypes.defineDeclaredKind(ctx, companyId, kind, actor);
  }

  /**
   * Replaces the whole required set (FR-007).
   *
   * Replace rather than merge: the required set is a set, and removing a kind has no
   * other honest expression. Every id is checked against the company's own document
   * types first — a requirement pointing at a type that does not exist is a kind no
   * project could ever satisfy, so every project would report itself permanently short
   * of a document nobody can upload.
   */
  async setRequirements(
    ctx: RlsContext,
    companyId: string,
    dto: SetProjectDocumentRequirementsDto,
    actor: { userId: string; ipAddress: string },
  ): Promise<ProjectDocumentRequirementSet> {
    const types = await this.documentTypes.listForCompany(companyId);
    const known = new Set(types.map((t) => t.id));
    const unknown = dto.requirements
      .map((r) => r.documentTypeId)
      .filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        message:
          `This company has no document type ${unknown.join(
            ', ',
          )}. A requirement ` +
          `naming a type that does not exist is a kind no project could ever satisfy.`,
        code: PROJECT_DOCUMENT_TYPE_UNKNOWN,
      });
    }

    // FR-007d. A kind cannot be marked **mandatory** while the company has no document type for
    // it: that would block every project creation with no way for anybody to comply, and the person
    // hitting the wall would be a Project Manager who cannot fix it. The same refusal the unknown
    // check above gives, at a different strength — and the type is definable in place through
    // `POST kinds/:code`, so the remedy is one call away rather than a settings expedition.
    const undefinedMandatory = dto.requirements
      .filter((r) => r.isMandatory !== false)
      .map((r) => r.documentTypeId)
      .filter((id) => !known.has(id));
    if (undefinedMandatory.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: PROJECT_DOCUMENT_KIND_NOT_DEFINED,
        message:
          `These kinds cannot be mandatory because this company has no document type for ` +
          `them: ${undefinedMandatory.join(
            ', ',
          )}. Define the type first — a mandatory kind ` +
          `nobody can file against would refuse every project creation with no way to comply.`,
      });
    }

    // Deduplicated before writing rather than relying on the unique index to reject the
    // call: a set sent with one kind twice is a client mistake, not a conflict worth
    // failing a whole configuration over.
    const seen = new Set<string>();
    const rows = dto.requirements.filter((r) =>
      seen.has(r.documentTypeId) ? false : (seen.add(r.documentTypeId), true),
    );

    await withRlsContext(this.prisma, ctx, async (tx) => {
      await tx.projectDocumentRequirement.deleteMany({ where: { companyId } });
      if (rows.length > 0) {
        await tx.projectDocumentRequirement.createMany({
          data: rows.map((r) => ({
            companyId,
            documentTypeId: r.documentTypeId,
            isMandatory: r.isMandatory ?? true,
          })),
        });
      }
    });

    await this.audit.record({
      entityType: AuditEntityType.PROJECT_DOCUMENT,
      action: AuditAction.UPDATE,
      entityId: null,
      changes: {
        requirements: rows.map((r) => ({
          documentTypeId: r.documentTypeId,
          isMandatory: r.isMandatory ?? true,
        })),
      },
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });

    return this.listRequirements(ctx, companyId);
  }

  /**
   * Readiness for MANY projects at once (FR-008) — the form the project list uses.
   *
   * **Constant query cost, whatever the page size.** Two statements: the required set,
   * then the documents held against it across every project in the list. The unit test
   * asserts the call list is identical for one project and for fifty, which is the
   * assertion that matters — a result-only test passes an N+1 happily, and the N+1 is
   * invisible in development where three projects hide it perfectly (quickstart Pass 4).
   *
   * Not literally one statement, as the task shorthand asks: the requirements and the
   * documents are different tables with no Prisma relation between them, and collapsing
   * them would mean hand-written SQL in a repository that has none. The invariant the
   * requirement protects is O(1) in projects, and two constant queries satisfy it.
   *
   * Only **mandatory** requirements count. A project short of an optional paper is not
   * unready; if optional kinds counted, `isMandatory` would change nothing anywhere.
   */
  async readinessFor(
    ctx: RlsContext,
    companyId: string,
    projectIds: string[],
  ): Promise<Map<string, ProjectDocumentReadiness>> {
    const empty = {
      required: 0,
      present: 0,
      missingTypeIds: [] as string[],
      advisoryRequired: 0,
      advisoryPresent: 0,
      advisoryMissingTypeIds: [] as string[],
    };
    const readiness = new Map<string, ProjectDocumentReadiness>(
      projectIds.map((id) => [id, { ...empty }]),
    );
    if (projectIds.length === 0) return readiness;

    const { mandatory: required, advisory } = await this.partitionedTypeIdsFor(
      ctx,
      companyId,
    );
    if (required.length === 0 && advisory.length === 0) return readiness;

    // One statement for the whole page. `documentTypeId: { in: required }` bounds the
    // result at projects × required kinds however many documents a project holds, and
    // `distinct` means two copies of the same certificate do not count twice.
    const held = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.projectDocument.findMany({
        where: {
          companyId,
          projectId: { in: projectIds },
          // Both partitions in one predicate, so the page still costs one query (T127).
          documentTypeId: { in: [...required, ...advisory] },
        },
        select: { projectId: true, documentTypeId: true },
        distinct: ['projectId', 'documentTypeId'],
      }),
    );

    const heldBy = new Map<string, Set<string>>();
    for (const row of held) {
      if (!row.documentTypeId) continue;
      const set = heldBy.get(row.projectId) ?? new Set<string>();
      set.add(row.documentTypeId);
      heldBy.set(row.projectId, set);
    }

    for (const projectId of projectIds) {
      const has = heldBy.get(projectId) ?? new Set<string>();
      const missingTypeIds = required.filter((id) => !has.has(id));
      const advisoryMissingTypeIds = advisory.filter((id) => !has.has(id));
      readiness.set(projectId, {
        // Mandatory only, unchanged. This figure is already on the portfolio list.
        required: required.length,
        present: required.length - missingTypeIds.length,
        missingTypeIds,
        advisoryRequired: advisory.length,
        advisoryPresent: advisory.length - advisoryMissingTypeIds.length,
        advisoryMissingTypeIds,
      });
    }
    return readiness;
  }

  /**
   * The single-project form. Exists beside the batch, and the **list must not use it** —
   * that is the N+1 the contract names explicitly.
   */
  async readinessForOne(
    ctx: RlsContext,
    companyId: string,
    projectId: string,
  ): Promise<ProjectDocumentReadiness> {
    const map = await this.readinessFor(ctx, companyId, [projectId]);
    return (
      map.get(projectId) ?? {
        required: 0,
        present: 0,
        missingTypeIds: [],
        advisoryRequired: 0,
        advisoryPresent: 0,
        advisoryMissingTypeIds: [],
      }
    );
  }

  /**
   * The mandatory required type ids, configured or shipped.
   *
   * The fallback is not a convenience. Without it a company that has configured nothing
   * reports every project complete — a readiness figure that is vacuously true, which is
   * worse than no figure at all because it looks like an answer.
   */
  private async mandatoryTypeIdsFor(
    ctx: RlsContext,
    companyId: string,
  ): Promise<string[]> {
    return (await this.partitionedTypeIdsFor(ctx, companyId)).mandatory;
  }

  /**
   * Both partitions of the required set, from the **one** query the mandatory resolver already ran
   * (017 FR-007b, T127).
   *
   * One statement for the whole page matters here and is asserted by a test: readiness is computed
   * for every project on the portfolio list, and a second query per partition would double that
   * cost for a figure the reader sees beside the first.
   */
  private async partitionedTypeIdsFor(
    ctx: RlsContext,
    companyId: string,
  ): Promise<{ mandatory: string[]; advisory: string[] }> {
    const configured = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.projectDocumentRequirement.findMany({
        where: { companyId },
        select: { documentTypeId: true, isMandatory: true },
      }),
    );

    // Falls back only when the set is empty, not when it holds no mandatory rows: a
    // company that deliberately marked every requirement optional has configured
    // something, and overriding that with the defaults would undo their decision.
    if (configured.length > 0) {
      return {
        mandatory: configured
          .filter((r) => r.isMandatory)
          .map((r) => r.documentTypeId),
        advisory: configured
          .filter((r) => !r.isMandatory)
          .map((r) => r.documentTypeId),
      };
    }

    const types = await this.documentTypes.listForCompany(companyId);
    const wanted = new Set(
      REQUIRED_PROJECT_DOCUMENT_KINDS.map((k) => k.code.toUpperCase()),
    );
    // The shipped defaults are all mandatory: they are the kinds the client named as required, and
    // a default that arrived advisory would gate nothing on a company that has configured nothing.
    return {
      mandatory: types
        .filter((t) => wanted.has(t.code.toUpperCase()))
        .map((t) => t.id),
      advisory: [],
    };
  }
  // ───────────────────────────────────────────────────────────────────────────
  // The upload path (017 FR-008a, FR-009b to FR-009e). Added by Phase 13.
  //
  // Until this existed, `ProjectDocument` was read by `readinessFor` and **written by nothing**.
  // The gate FR-009 describes was the small part; the path it gates is the part that was missing.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Files a document against an existing project (FR-008a).
   *
   * `documentTypeId` is optional: supplied, the document answers a required kind; omitted, it is
   * supplementary. That is already what null means on the column, so this adds no vocabulary.
   */
  async upload(
    ctx: RlsContext,
    companyId: string,
    projectId: string,
    input: {
      documentTypeId?: string;
      documentType: string;
      data: Buffer;
      contentType: string;
      /** The uploader's own file name, so the download is not `<kind>-<id>` with no extension. */
      fileName?: string;
      remark?: string;
    },
    actorUserId: string,
  ) {
    if (input.documentTypeId) {
      await this.assertTypeExists(ctx, companyId, input.documentTypeId);
    }

    const fileRef = await this.storage.put(
      `project-documents/${companyId}`,
      input.data,
      input.contentType,
    );

    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.projectDocument.create({
        data: {
          companyId,
          projectId,
          documentType: input.documentType,
          documentTypeId: input.documentTypeId ?? null,
          fileRef,
          fileName: input.fileName ?? null,
          mimeType: input.contentType,
          remark: input.remark ?? null,
          uploadedByUserId: actorUserId,
        },
      }),
    );
  }

  /**
   * Every document filed against a project — required and supplementary alike (FR-008a).
   *
   * **Deliberately unfiltered by `documentTypeId`.** Filtering to the required set is exactly what
   * made supplementary company documents invisible and produced this feature's amendment D1, and
   * the same mistake is available here. Readiness is one view of a project's papers; it must not be
   * the only one.
   */
  async listForProject(ctx: RlsContext, companyId: string, projectId: string) {
    const documents = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.projectDocument.findMany({
        where: { companyId, projectId },
        orderBy: { uploadedAt: 'desc' },
      }),
    );
    if (documents.length === 0)
      return documents.map((d) => ({ ...d, uploadedByName: null }));

    // Who filed it, by name (web T077). `uploadedByUserId` is a bare id, and a list of a
    // project's papers reading "filed by cmuoe9b7l00q5v8…" answers half the question it was
    // asked. One query for the page's distinct uploaders, not one per row.
    const names = await this.actorNames([
      ...new Set(documents.map((d) => d.uploadedByUserId)),
    ]);
    return documents.map((document) => ({
      ...document,
      uploadedByName: names.get(document.uploadedByUserId) ?? null,
    }));
  }

  /**
   * Retrieves one project document's bytes (FR-008a, web T077).
   *
   * **Scoped by project as well as by id.** A document id alone would be enough for the row the
   * caller is looking at, but passing the project through means a mismatched pair cannot resolve
   * — so a document id guessed or copied from another project is a 404 rather than a download.
   *
   * No audit entry, unlike `CompanyDocumentsService.download`. That asymmetry is deliberate and
   * worth writing down: company documents have restricted kinds whose *retrieval* is the thing
   * worth knowing about, and FR-024 says so. Project documents carry no restriction vocabulary,
   * so there is nothing here an auditor would be reading the log for. If project kinds ever gain
   * restriction, this is the method that must gain the entry.
   */
  async downloadForProject(
    ctx: RlsContext,
    companyId: string,
    projectId: string,
    documentId: string,
  ): Promise<{ data: Buffer; filename: string; contentType: string }> {
    const document = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.projectDocument.findFirst({
        where: { id: documentId, projectId, companyId },
      }),
    );
    if (!document) throw new NotFoundException('Document not found.');

    const data = await this.storage.get(document.fileRef);
    const described = describeStoredFile({
      bytes: data,
      storedName: document.fileName,
      storedType: document.mimeType,
      // The free-text label, not the id: this is what a person sees in their downloads folder.
      // Sanitised because it is user-supplied and ends up in a header.
      fallbackName: `${document.documentType.replace(
        /[^A-Za-z0-9._-]+/g,
        '-',
      )}-${document.id}`,
    });
    return { data, ...described };
  }

  /** User ids to display names, in one query. */
  private async actorNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findMany({
          where: { id: { in: ids } },
          select: ACTOR_NAME_SELECT,
        }),
    );
    return new Map(users.map((user) => [user.id, actorNameOf(user)]));
  }

  /**
   * Stages a document before its project exists (FR-009b).
   *
   * Records `uploadedBy` from the caller, which project creation checks rather than merely
   * displays — see the schema comment.
   */
  async stage(
    ctx: RlsContext,
    companyId: string,
    input: {
      documentTypeId?: string;
      documentType: string;
      data: Buffer;
      contentType: string;
      fileName?: string;
    },
    actorUserId: string,
  ): Promise<{ stagedDocumentId: string }> {
    if (input.documentTypeId) {
      await this.assertTypeExists(ctx, companyId, input.documentTypeId);
    }

    const fileRef = await this.storage.put(
      `project-documents-staged/${companyId}`,
      input.data,
      input.contentType,
    );

    const staged = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.stagedProjectDocument.create({
        data: {
          companyId,
          documentTypeId: input.documentTypeId ?? null,
          documentType: input.documentType,
          fileRef,
          fileName: input.fileName ?? null,
          mimeType: input.contentType,
          uploadedBy: actorUserId,
        },
      }),
    );
    return { stagedDocumentId: staged.id };
  }

  /**
   * Refuses a project creation whose mandatory kinds are not all attached (FR-009, FR-009a).
   *
   * Names every missing kind's **label**, never its id: a refusal naming internal identifiers is
   * one the reader cannot act on.
   *
   * Also resolves the staged rows the creation will consume, and refuses any the caller may not use
   * (FR-009c) — done here rather than in the caller so the two checks cannot be applied apart.
   */
  async assertMandatoryKindsSatisfied(
    ctx: RlsContext,
    companyId: string,
    stagedIds: string[],
    actorUserId: string,
  ): Promise<
    {
      id: string;
      documentTypeId: string | null;
      documentType: string;
      fileRef: string;
      filePath: string | null;
      fileName: string | null;
      mimeType: string | null;
    }[]
  > {
    const staged = stagedIds.length
      ? await withRlsContext(this.prisma, ctx, (tx) =>
          tx.stagedProjectDocument.findMany({
            where: { companyId, id: { in: stagedIds } },
          }),
        )
      : [];

    // FR-009c. Every id must exist, belong to this company, and have been staged by this caller —
    // and all three failures give the SAME code, so a refusal cannot be used to discover that
    // somebody else's staged document exists.
    const usable = new Map(
      staged
        .filter((row) => row.uploadedBy === actorUserId)
        .map((row) => [row.id, row]),
    );
    const unusable = stagedIds.filter((id) => !usable.has(id));
    if (unusable.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: PROJECT_STAGED_DOCUMENT_UNKNOWN,
        message:
          `${unusable.length} staged document reference(s) are not usable by this caller. ` +
          `A reference can only be used by the person who uploaded it, and only once.`,
      });
    }

    const requirements = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.projectDocumentRequirement.findMany({
        where: { companyId, isMandatory: true },
      }),
    );

    const attached = new Set(
      [...usable.values()]
        .map((row) => row.documentTypeId)
        .filter(Boolean) as string[],
    );
    const missing = requirements.filter(
      (requirement) => !attached.has(requirement.documentTypeId),
    );

    if (missing.length > 0) {
      const labels = await this.labelsForTypeIds(
        ctx,
        companyId,
        missing.map((m) => m.documentTypeId),
      );
      throw new BadRequestException({
        statusCode: 400,
        code: PROJECT_DOCUMENTS_MANDATORY_MISSING,
        message:
          `This project cannot be created until a document is attached for every mandatory ` +
          `kind. Missing: ${missing
            .map((m) => labels.get(m.documentTypeId) ?? m.documentTypeId)
            .join(', ')}.`,
        missingKinds: missing.map(
          (m) => labels.get(m.documentTypeId) ?? m.documentTypeId,
        ),
        // The machine-readable half of the same refusal (web T072).
        //
        // `missingKinds` above is for a person to read and must stay labels — FR-009a is explicit
        // that a refusal naming internal identifiers is one the reader cannot act on. But a form
        // has to put each name *on the control it refers to*, and matching a display label back to
        // a control means string-matching two names that are only incidentally equal: two kinds
        // may legitimately share a name, and a rename breaks the match silently. The ids make that
        // exact; they are additive, and nothing is expected to render them.
        missingTypeIds: missing.map((m) => m.documentTypeId),
      });
    }

    return [...usable.values()].map((row) => ({
      id: row.id,
      documentTypeId: row.documentTypeId,
      documentType: row.documentType,
      fileRef: row.fileRef,
      filePath: row.filePath,
      // Carried through the promotion, so a document staged before its project existed is not
      // the one that downloads as `<kind>-<id>` with no extension.
      fileName: row.fileName,
      mimeType: row.mimeType,
    }));
  }

  /**
   * Deletes staged documents past the retention window, **with their blobs** (FR-009d).
   *
   * The blob first would risk a row pointing at nothing; the row first would risk an orphan blob.
   * Rows are read, then deleted, then blobs removed — an orphaned blob is a wasted object and an
   * orphaned row is a broken reference, so the cheaper failure is chosen deliberately.
   */
  async sweepStaged(now = new Date()): Promise<number> {
    const hours = this.retentionHours;
    const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);

    const stale = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.stagedProjectDocument.findMany({
          where: { createdAt: { lt: cutoff } },
          select: { id: true, fileRef: true },
        }),
    );
    if (stale.length === 0) return 0;

    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.stagedProjectDocument.deleteMany({
        where: { id: { in: stale.map((row) => row.id) } },
      }),
    );
    await this.storage.deleteMany(stale.map((row) => row.fileRef));
    return stale.length;
  }

  /**
   * The kinds' human labels, for a refusal a reader can act on.
   *
   * Through `DocumentTypesService`, not a query: `DocumentType` lives in `settings` and this module
   * may not read it (Principle I) — the same reason `documentTypeId` is a bare string here rather
   * than a foreign key. Caught in review of this method's first draft, which queried it directly.
   */
  private async labelsForTypeIds(
    _ctx: RlsContext,
    companyId: string,
    typeIds: string[],
  ): Promise<Map<string, string>> {
    const wanted = new Set(typeIds);
    const types = await this.documentTypes.listForCompany(companyId);
    return new Map(
      types
        .filter((type) => wanted.has(type.id))
        .map((type) => [type.id, type.name]),
    );
  }

  private async assertTypeExists(
    _ctx: RlsContext,
    companyId: string,
    documentTypeId: string,
  ): Promise<void> {
    const types = await this.documentTypes.listForCompany(companyId);
    if (!types.some((type) => type.id === documentTypeId)) {
      throw new BadRequestException({
        statusCode: 400,
        code: PROJECT_DOCUMENT_TYPE_UNKNOWN,
        message: 'That document type does not exist for this company.',
      });
    }
  }
}
