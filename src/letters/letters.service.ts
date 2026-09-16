import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import * as PDFDocument from 'pdfkit';

import { ApprovalService } from '../approvals/approvals.service';
import { AuditLogService } from '../auth/audit-log.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../common/prisma/rls-context';
import { StorageService } from '../common/storage/storage.service';
import { DocumentTypesService } from '../settings/reference-data/document-types.service';
import { LetterKindsService } from '../settings/letter-kinds/letter-kinds.service';
import { LetterTemplatesService } from '../settings/letter-templates/letter-templates.service';
import { SignatoriesService } from '../settings/signatories/signatories.service';
import { ComposeLetterDto, ReissueLetterDto } from './dto/letter.dto';
import {
  LETTER_ALREADY_ISSUED,
  LETTER_KIND_FORBIDDEN,
  LETTER_NOT_ISSUED,
  LETTER_TEMPLATE_MISSING,
  SIGNATORY_REQUIRED,
} from './letter-error-codes';
import { permissionForKind } from './letter-permissions';
import { assertNoRestrictedTypes, renderTemplate } from './template-resolver';

/** Where letter PDFs live in blob storage. */
export const LETTER_NAMESPACE = 'letter';

export interface IssuedLetterView {
  id: string;
  letterKindId: string;
  letterKindKey: string;
  letterKindLabel: string;
  employeeId: string | null;
  candidateId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  version: number;
  isSuperseded: boolean;
  signatoryId: string | null;
  /** True once the signature graphic has been frozen onto the rendered document. */
  isSigned: boolean;
  issuedAt: Date | null;
  /** FR-018: "issued" until the executed copy comes back, then "executed". */
  status: 'composed' | 'issued' | 'executed';
  countersignedAt: Date | null;
  requiresApproval: boolean;
}

type LetterRow = Prisma.IssuedLetterGetPayload<{
  include: { letterKind: true };
}>;

function toView(row: LetterRow): IssuedLetterView {
  return {
    id: row.id,
    letterKindId: row.letterKindId,
    letterKindKey: row.letterKind.key,
    letterKindLabel: row.letterKind.label,
    employeeId: row.employeeId,
    candidateId: row.candidateId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    version: row.version,
    isSuperseded: row.isSuperseded,
    signatoryId: row.signatoryId,
    isSigned: row.appliedSignatureRef !== null,
    issuedAt: row.issuedAt,
    status:
      row.countersignedAt !== null
        ? 'executed'
        : row.issuedAt !== null
        ? 'issued'
        : 'composed',
    countersignedAt: row.countersignedAt,
    requiresApproval: row.letterKind.requiresApproval,
  };
}

/** Renders plain text into a single-column A4 PDF buffer. */
function renderPdf(
  title: string,
  body: string,
  signature?: { image: Buffer; name: string; title: string },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(16).text(title, { align: 'center' });
    doc.moveDown();
    doc.fontSize(11).text(body, { align: 'left' });
    if (signature) {
      doc.moveDown(2);
      try {
        doc.image(signature.image, { width: 140 });
      } catch {
        // A signature graphic that pdfkit cannot decode must not lose the letter. The
        // name and title below still identify the signatory, and `appliedSignatureRef`
        // still records what was meant to be applied.
        doc.fontSize(10).text('[signature]');
      }
      doc.fontSize(11).text(signature.name);
      doc.fontSize(10).text(signature.title);
    }
    doc.end();
  });
}

/**
 * Letters (017 US3, US4, US6).
 *
 * Lives in `src/letters/` and owns `shared.IssuedLetter`. It addresses employees,
 * candidates and an **opaque** `(subjectType, subjectId)` pair that it never
 * dereferences — resolving `vendor-abc` to a vendor name would be the cross-schema read
 * the whole Phase 5 restructure existed to avoid.
 */
@Injectable()
export class LettersService {
  private readonly logger = new Logger(LettersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditLogService,
    private readonly kinds: LetterKindsService,
    private readonly templates: LetterTemplatesService,
    private readonly documentTypes: DocumentTypesService,
    private readonly signatories: SignatoriesService,
    private readonly approvals: ApprovalService,
  ) {}

  /**
   * Compose a letter, and issue it when nothing is gating it (FR-015a).
   *
   * A gated kind stops here with the letter composed and its 016 chain raised. It is
   * issued by `issue()` once the chain completes — which is why `issuedAt` is nullable
   * and why the composer offers Preview but not Issue until then.
   */
  async compose(
    caller: AuthenticatedUser,
    dto: ComposeLetterDto,
  ): Promise<IssuedLetterView> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const kind = await this.kinds.requireByKey(
      ctx,
      companyId,
      dto.letterKindKey,
    );
    this.assertMayActOnKind(caller, kind.key);
    this.assertExactlyOneSubject(dto);

    if (kind.requiresSignature && !dto.signatoryId) {
      throw new BadRequestException({
        statusCode: 400,
        message: `A ${kind.label} carries a signature, so a signatory must be named.`,
        code: SIGNATORY_REQUIRED,
      });
    }

    const template = await this.requireTemplate(
      ctx,
      companyId,
      kind.id,
      kind.label,
    );
    await this.assertTemplateIsRenderable(companyId, template.bodyTemplate);

    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.issuedLetter.create({
        data: {
          companyId,
          letterKindId: kind.id,
          employeeId: dto.employeeId ?? null,
          candidateId: dto.candidateId ?? null,
          subjectType: dto.subjectType ?? null,
          subjectId: dto.subjectId ?? null,
          templateId: template.id,
          signatoryId: dto.signatoryId ?? null,
          // Composed, not issued: no rendered document yet, because a rendered draft is
          // a file indistinguishable from the real thing.
          renderedRef: '',
          issuedAt: null,
          issuedBy: caller.id,
        },
        include: { letterKind: true },
      }),
    );

    if (kind.requiresApproval && kind.approvalActionType) {
      await this.raiseApproval(caller, companyId, row, kind.approvalActionType);
      // Stops here on purpose. The chain decides whether this ever becomes a document.
      return toView(row);
    }

    return this.issue(caller, row.id, dto.variables);
  }

  /**
   * Render and issue a composed letter (FR-015a).
   *
   * The approval gate is 016's, called and not reimplemented: `assertMayTakeEffect`
   * answers "may this take effect?" and this service consumes the answer. Two
   * implementations of one rule is how the rule gets enforced in one place and not the
   * other, and the place it is missed is found by the money having already moved.
   */
  async issue(
    caller: AuthenticatedUser,
    letterId: string,
    variables: Record<string, string>,
  ): Promise<IssuedLetterView> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const letter = await this.requireLetter(ctx, companyId, letterId);
    this.assertMayActOnKind(caller, letter.letterKind.key);

    if (letter.issuedAt !== null) {
      throw new ConflictException({
        statusCode: 409,
        message:
          'This letter has already been issued. Correcting an issued letter is a ' +
          'reissue, which supersedes it and keeps both versions retrievable.',
        code: LETTER_ALREADY_ISSUED,
      });
    }

    if (
      letter.letterKind.requiresApproval &&
      letter.letterKind.approvalActionType
    ) {
      await this.approvals.assertMayTakeEffect({
        actionType: letter.letterKind.approvalActionType,
        entityType: letter.letterKind.approvalActionType,
        entityId: letter.id,
        companyId,
      });
    }

    const rendered = await this.render(ctx, companyId, letter, variables);

    const updated = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.issuedLetter.update({
        where: { id: letter.id },
        data: {
          renderedRef: rendered.ref,
          appliedSignatureRef: rendered.appliedSignatureRef,
          issuedAt: new Date(),
          issuedBy: caller.id,
        },
        include: { letterKind: true },
      }),
    );

    await this.audit.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.CREATE,
      entityId: updated.id,
      changes: { kind: updated.letterKind.key, version: updated.version },
      accountId: caller.id,
      companyId,
      ipAddress: '',
    });
    return toView(updated);
  }

  /**
   * Reissue: a new version that supersedes the old one, which stays retrievable (FR-014).
   *
   * Supersede rather than overwrite, and the old file is NOT deleted. A letter that went
   * out is a fact about the world; replacing the bytes behind its id would let the
   * company assert it had always said something it did not.
   */
  async reissue(
    caller: AuthenticatedUser,
    letterId: string,
    dto: ReissueLetterDto,
  ): Promise<IssuedLetterView> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const original = await this.requireLetter(ctx, companyId, letterId);
    this.assertMayActOnKind(caller, original.letterKind.key);

    if (original.issuedAt === null) {
      throw new ConflictException({
        statusCode: 409,
        message:
          'This letter has not been issued yet, so there is nothing to supersede. ' +
          'Issue it first.',
        code: LETTER_NOT_ISSUED,
      });
    }

    const signatoryId = dto.signatoryId ?? original.signatoryId;
    const rendered = await this.render(
      ctx,
      companyId,
      { ...original, signatoryId },
      dto.variables,
    );

    const created = await withRlsContext(this.prisma, ctx, async (tx) => {
      await tx.issuedLetter.update({
        where: { id: original.id },
        data: { isSuperseded: true },
      });
      return tx.issuedLetter.create({
        data: {
          companyId,
          letterKindId: original.letterKindId,
          employeeId: original.employeeId,
          candidateId: original.candidateId,
          subjectType: original.subjectType,
          subjectId: original.subjectId,
          templateId: original.templateId,
          signatoryId,
          appliedSignatureRef: rendered.appliedSignatureRef,
          renderedRef: rendered.ref,
          version: original.version + 1,
          issuedAt: new Date(),
          issuedBy: caller.id,
        },
        include: { letterKind: true },
      });
    });

    await this.audit.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.UPDATE,
      entityId: created.id,
      changes: {
        supersedes: original.id,
        version: created.version,
        kind: created.letterKind.key,
      },
      accountId: caller.id,
      companyId,
      ipAddress: '',
    });
    return toView(created);
  }

  /** The bytes, exactly as issued (FR-013). */
  async download(
    caller: AuthenticatedUser,
    letterId: string,
  ): Promise<{ data: Buffer; view: IssuedLetterView }> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const letter = await this.requireLetter(ctx, companyId, letterId);
    this.assertMayActOnKind(caller, letter.letterKind.key);

    if (!letter.renderedRef) {
      throw new ConflictException({
        statusCode: 409,
        message:
          'This letter has been composed but not issued, so there is no document yet.',
        code: LETTER_NOT_ISSUED,
      });
    }

    const data = await this.storage.get(letter.renderedRef);
    return { data, view: toView(letter) };
  }

  /** The executed copy that comes back (FR-017, FR-018). */
  async attachCountersigned(
    caller: AuthenticatedUser,
    letterId: string,
    input: { data: Buffer; contentType: string },
  ): Promise<IssuedLetterView> {
    const companyId = this.companyOf(caller);
    const ctx = rlsContextFor(caller);
    const letter = await this.requireLetter(ctx, companyId, letterId);
    this.assertMayActOnKind(caller, letter.letterKind.key);

    if (letter.issuedAt === null) {
      throw new ConflictException({
        statusCode: 409,
        message: 'An unissued letter cannot have been countersigned.',
        code: LETTER_NOT_ISSUED,
      });
    }

    const ref = await this.storage.put(
      `${LETTER_NAMESPACE}-countersigned/${companyId}`,
      input.data,
      input.contentType,
    );

    const updated = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.issuedLetter.update({
        where: { id: letter.id },
        data: { countersignedRef: ref, countersignedAt: new Date() },
        include: { letterKind: true },
      }),
    );

    // The issued copy keeps its own `renderedRef`. Two distinguishable documents, which
    // is the whole of FR-018: "we sent this" and "they signed it" are different claims.
    return toView(updated);
  }

  /**
   * Letters for one subject (FR-019) — the opaque pair, never resolved.
   *
   * Exported so project, candidate and vendor screens list their letters through this
   * method rather than querying `shared.IssuedLetter` (Principle I, T062).
   */
  async listForSubject(
    caller: AuthenticatedUser,
    query: {
      subjectType?: string;
      subjectId?: string;
      employeeId?: string;
      candidateId?: string;
      includeSuperseded?: boolean;
    },
  ): Promise<IssuedLetterView[]> {
    const companyId = this.companyOf(caller);
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.issuedLetter.findMany({
          where: {
            companyId,
            ...(query.subjectType ? { subjectType: query.subjectType } : {}),
            ...(query.subjectId ? { subjectId: query.subjectId } : {}),
            ...(query.employeeId ? { employeeId: query.employeeId } : {}),
            ...(query.candidateId ? { candidateId: query.candidateId } : {}),
            ...(query.includeSuperseded ? {} : { isSuperseded: false }),
          },
          include: { letterKind: true },
          orderBy: [{ createdAt: 'desc' }],
        }),
    );
    // Filtered to what this caller may see, per kind. A list that showed the existence
    // of purchase orders to somebody who may not read them leaks the thing the per-kind
    // permission exists to protect.
    return rows
      .filter((r) => this.mayActOnKind(caller, r.letterKind.key))
      .map(toView);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async render(
    ctx: ReturnType<typeof rlsContextFor>,
    companyId: string,
    letter: {
      templateId: string;
      letterKind: { label: string; requiresSignature: boolean };
      signatoryId: string | null;
    },
    variables: Record<string, string>,
  ): Promise<{ ref: string; appliedSignatureRef: string | null }> {
    const template = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.letterTemplate.findFirst({
        where: { id: letter.templateId, companyId },
      }),
    );
    if (!template) {
      throw new ConflictException({
        statusCode: 409,
        message: 'The template this letter was composed from no longer exists.',
        code: LETTER_TEMPLATE_MISSING,
      });
    }
    await this.assertTemplateIsRenderable(companyId, template.bodyTemplate);

    let signature: { image: Buffer; name: string; title: string } | undefined;
    let appliedSignatureRef: string | null = null;
    if (letter.letterKind.requiresSignature && letter.signatoryId) {
      const signatory = await this.signatories.requireById(
        ctx,
        companyId,
        letter.signatoryId,
      );
      // BOTH the id and the graphic (research §5). Storing only the id would re-render
      // this letter with whatever image the signatory has *today* — FR-013 says a
      // previously issued letter renders as it was issued, and a signature that silently
      // changes is the one thing a signature may never do.
      appliedSignatureRef = signatory.signatureRef;
      signature = {
        image: await this.storage.get(signatory.signatureRef),
        name: signatory.name,
        title: signatory.title,
      };
    }

    const body = renderTemplate(template.bodyTemplate, variables);
    const pdf = await renderPdf(
      letter.letterKind.label.toUpperCase(),
      body,
      signature,
    );
    const ref = await this.storage.put(
      `${LETTER_NAMESPACE}/${companyId}`,
      pdf,
      'application/pdf',
    );
    return { ref, appliedSignatureRef };
  }

  /**
   * FR-024, enforced on every render rather than only at template save.
   *
   * Checked here as well as at save because `isRestricted` can be switched on *after* a
   * template was written. A rule enforced only at save would let an existing template
   * keep rendering the thing that just became regulated.
   */
  private async assertTemplateIsRenderable(
    companyId: string,
    body: string,
  ): Promise<void> {
    const types = await this.documentTypes.listForCompany(companyId);
    assertNoRestrictedTypes(body, types);
  }

  private async requireTemplate(
    ctx: ReturnType<typeof rlsContextFor>,
    companyId: string,
    letterKindId: string,
    kindLabel: string,
  ) {
    const template = await withRlsContext(this.prisma, ctx, (tx) =>
      this.templates.getActive(companyId, letterKindId, tx),
    );
    if (!template) {
      throw new ConflictException({
        statusCode: 409,
        message: `No active ${kindLabel} template exists. Create one first.`,
        code: LETTER_TEMPLATE_MISSING,
      });
    }
    return template;
  }

  private async requireLetter(
    ctx: ReturnType<typeof rlsContextFor>,
    companyId: string,
    id: string,
  ): Promise<LetterRow> {
    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.issuedLetter.findFirst({
        where: { id, companyId },
        include: { letterKind: true },
      }),
    );
    if (!row) throw new NotFoundException(`Letter ${id} not found.`);
    return row;
  }

  private async raiseApproval(
    caller: AuthenticatedUser,
    companyId: string,
    letter: LetterRow,
    actionType: string,
  ): Promise<void> {
    const subject =
      `${letter.letterKind.label} — ` +
      (letter.subjectId
        ? `${letter.subjectType ?? 'subject'} ${letter.subjectId}`
        : letter.employeeId ?? letter.candidateId ?? 'unaddressed');

    try {
      await this.approvals.submit({
        companyId,
        actionType,
        entityType: actionType,
        entityId: letter.id,
        originatorUserId: caller.id,
        subject,
        href: `/dashboard/letters/${letter.id}`,
        viewPermission: permissionForKind(letter.letterKind.key),
      });
    } catch (error) {
      // The letter stays composed and unissued, which is the safe state: it cannot take
      // effect without a completed chain, and `issue()` refuses it. Logged because the
      // person who hits the refusal is not the person who can configure the chain.
      this.logger.error(
        `Letter ${letter.id} (${letter.letterKind.key}) was composed but could not ` +
          `enter an approval chain: ${
            error instanceof Error ? error.message : String(error)
          }. It cannot be issued until this is fixed.`,
      );
      throw error;
    }
  }

  private assertExactlyOneSubject(dto: ComposeLetterDto): void {
    const person = Boolean(dto.employeeId || dto.candidateId);
    const opaque = Boolean(dto.subjectType && dto.subjectId);
    if (person === opaque) {
      throw new BadRequestException(
        person
          ? 'A letter addresses a person or a subject, not both — "who is this letter ' +
            'for?" must have one answer.'
          : 'A letter must address an employee, a candidate, or a subjectType/subjectId pair.',
      );
    }
    if (Boolean(dto.subjectType) !== Boolean(dto.subjectId)) {
      throw new BadRequestException(
        'subjectType and subjectId are meaningless apart; supply both or neither.',
      );
    }
  }

  private mayActOnKind(caller: AuthenticatedUser, key: string): boolean {
    return caller.permissions.includes(permissionForKind(key));
  }

  private assertMayActOnKind(caller: AuthenticatedUser, key: string): void {
    if (this.mayActOnKind(caller, key)) return;
    throw new ForbiddenException({
      statusCode: 403,
      message:
        `Your roles do not carry the permission a "${key}" letter requires. There is no ` +
        `single letters permission: a work order and a relieving letter are not the ` +
        `same authority.`,
      code: LETTER_KIND_FORBIDDEN,
    });
  }

  private companyOf(caller: AuthenticatedUser): string {
    if (!caller.companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return caller.companyId;
  }
}
