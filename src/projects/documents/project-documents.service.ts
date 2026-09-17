import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditAction, AuditEntityType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { REQUIRED_PROJECT_DOCUMENT_KINDS } from '../../settings/document-kinds';
import { DocumentTypesService } from '../../settings/reference-data/document-types.service';
import {
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
  required: number;
  present: number;
  missingTypeIds: string[];
}

@Injectable()
export class ProjectDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentTypes: DocumentTypesService,
    private readonly audit: AuditLogService,
  ) {}

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
    const readiness = new Map<string, ProjectDocumentReadiness>(
      projectIds.map((id) => [
        id,
        { required: 0, present: 0, missingTypeIds: [] },
      ]),
    );
    if (projectIds.length === 0) return readiness;

    const required = await this.mandatoryTypeIdsFor(ctx, companyId);
    if (required.length === 0) return readiness;

    // One statement for the whole page. `documentTypeId: { in: required }` bounds the
    // result at projects × required kinds however many documents a project holds, and
    // `distinct` means two copies of the same certificate do not count twice.
    const held = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.projectDocument.findMany({
        where: {
          companyId,
          projectId: { in: projectIds },
          documentTypeId: { in: required },
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
      readiness.set(projectId, {
        required: required.length,
        present: required.length - missingTypeIds.length,
        missingTypeIds,
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
      map.get(projectId) ?? { required: 0, present: 0, missingTypeIds: [] }
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
      return configured
        .filter((r) => r.isMandatory)
        .map((r) => r.documentTypeId);
    }

    const types = await this.documentTypes.listForCompany(companyId);
    const wanted = new Set(
      REQUIRED_PROJECT_DOCUMENT_KINDS.map((k) => k.code.toUpperCase()),
    );
    return types
      .filter((t) => wanted.has(t.code.toUpperCase()))
      .map((t) => t.id);
  }
}
