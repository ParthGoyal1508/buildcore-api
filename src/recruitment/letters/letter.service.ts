import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  LetterType,
  Prisma,
  ResignationStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import * as PDFDocument from 'pdfkit';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { LETTER_NAMESPACE } from '../constants/recruitment.constants';
import { RecruitmentRefsService } from '../recruitment-refs.service';
import { renderTemplate } from './letter-tokens.util';

/** Renders plain text into a single-column A4 PDF buffer. */
function renderPdf(title: string, body: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(16).text(title, { align: 'center' });
    doc.moveDown();
    doc.fontSize(11).text(body, { align: 'left' });
    doc.end();
  });
}

const dateOnly = (d: Date | null | undefined): string =>
  d ? d.toISOString().slice(0, 10) : '';

@Injectable()
export class LetterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly storage: StorageService,
    private readonly refs: RecruitmentRefsService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: { companyId?: string; letterType?: LetterType; employeeId?: string },
  ) {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.generatedLetter.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            ...(query.letterType ? { letterType: query.letterType } : {}),
            ...(query.employeeId ? { employeeId: query.employeeId } : {}),
          },
          orderBy: [{ issuedAt: 'desc' }],
        }),
    );
    return rows.map((r) => ({
      id: r.id,
      letterType: r.letterType,
      employeeId: r.employeeId,
      candidateId: r.candidateId,
      version: r.version,
      isSuperseded: r.isSuperseded,
      issuedAt: r.issuedAt.toISOString(),
    }));
  }

  /** Generates a letter for an employee (appointment/confirmation/relieving/experience). */
  async generateForEmployee(
    caller: AuthenticatedUser,
    dto: { letterType: LetterType; employeeId: string },
    ipAddress: string,
  ) {
    const companyId = companyScope(caller).companyId;
    if (!companyId) throw new NotFoundException('Company not found');

    if (dto.letterType === LetterType.relieving) {
      const processed = await this.refs.isFnfProcessed(caller, dto.employeeId);
      if (!processed) {
        throw new ConflictException(
          'A relieving letter requires a processed Full & Final settlement first.',
        );
      }
    }

    const employee = await this.refs.getEmployee(caller, dto.employeeId);
    if (!employee) throw new NotFoundException('Employee not found');

    const companyName = await this.refs.companyName(companyId);
    const designation = employee.designationId
      ? await this.refs.designationName(caller, employee.designationId)
      : '';
    const department = employee.departmentId
      ? await this.refs.departmentName(caller, employee.departmentId)
      : '';

    let lastWorkingDay = '';
    let tenure = '';
    if (
      dto.letterType === LetterType.relieving ||
      dto.letterType === LetterType.experience
    ) {
      const resignation = await withRlsContext(
        this.prisma,
        rlsContextFor(caller),
        (tx) =>
          tx.resignation.findFirst({
            where: {
              employeeId: dto.employeeId,
              status: ResignationStatus.accepted,
            },
            orderBy: { createdAt: 'desc' },
          }),
      );
      const lwd =
        resignation?.agreedLastWorkingDay ??
        resignation?.expectedLastWorkingDay ??
        null;
      lastWorkingDay = dateOnly(lwd);
      if (employee.dateOfJoining && lwd) {
        const months =
          (lwd.getFullYear() - employee.dateOfJoining.getFullYear()) * 12 +
          (lwd.getMonth() - employee.dateOfJoining.getMonth());
        tenure = `${Math.max(0, months)} months`;
      }
    }

    const values: Record<string, string> = {
      employeeName: [employee.firstName, employee.lastName]
        .filter(Boolean)
        .join(' '),
      employeeCode: employee.employeeCode,
      designation,
      department,
      dateOfJoining: dateOnly(employee.dateOfJoining),
      confirmationDate: dateOnly(employee.confirmationDate),
      lastWorkingDay,
      tenure,
      companyName,
      issueDate: dateOnly(new Date()),
    };

    return this.render(caller, {
      companyId,
      letterType: dto.letterType,
      employeeId: dto.employeeId,
      candidateId: null,
      values,
      ipAddress,
    });
  }

  /** Generates the offer letter for an offer (called from the offer flow). */
  async generateForOffer(
    caller: AuthenticatedUser,
    offer: {
      id: string;
      companyId: string;
      candidateId: string;
      designationId: string;
      departmentId: string;
      offeredCtc: Prisma.Decimal;
      proposedJoiningDate: Date;
      confirmedJoiningDate: Date | null;
      probationMonths: number;
      noticePeriodDays: number;
    },
    ipAddress: string,
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const candidate = await tx.candidate.findUnique({
      where: { id: offer.candidateId },
      select: { fullName: true },
    });
    const companyName = await this.refs.companyName(offer.companyId);
    const designation = await this.refs.designationName(
      caller,
      offer.designationId,
    );
    const department = await this.refs.departmentName(
      caller,
      offer.departmentId,
    );

    const values: Record<string, string> = {
      candidateName: candidate?.fullName ?? '',
      designation,
      department,
      offeredCtc: offer.offeredCtc.toNumber().toLocaleString('en-IN'),
      joiningDate: dateOnly(
        offer.confirmedJoiningDate ?? offer.proposedJoiningDate,
      ),
      probationMonths: String(offer.probationMonths),
      noticePeriodDays: String(offer.noticePeriodDays),
      companyName,
      issueDate: dateOnly(new Date()),
    };

    const letter = await this.renderInTx(tx, caller, {
      companyId: offer.companyId,
      letterType: LetterType.offer,
      employeeId: null,
      candidateId: offer.candidateId,
      values,
      ipAddress,
    });
    return letter.id;
  }

  async download(
    caller: AuthenticatedUser,
    letterId: string,
    ipAddress: string,
  ) {
    const letter = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.generatedLetter.findUnique({ where: { id: letterId } }),
    );
    if (!letter) throw new NotFoundException(`Letter ${letterId} not found`);
    assertInScope(caller, letter, `Letter ${letterId}`);
    const buffer = await this.storage.get(letter.renderedRef);
    await this.auditLog.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.READ,
      entityId: letterId,
      accountId: caller.id,
      companyId: letter.companyId,
      ipAddress,
    });
    return { buffer, filename: `${letter.letterType}-v${letter.version}.pdf` };
  }

  private async render(
    caller: AuthenticatedUser,
    input: {
      companyId: string;
      letterType: LetterType;
      employeeId: string | null;
      candidateId: string | null;
      values: Record<string, string>;
      ipAddress: string;
    },
  ) {
    return withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      this.renderInTx(tx, caller, input),
    );
  }

  private async renderInTx(
    tx: Prisma.TransactionClient,
    caller: AuthenticatedUser,
    input: {
      companyId: string;
      letterType: LetterType;
      employeeId: string | null;
      candidateId: string | null;
      values: Record<string, string>;
      ipAddress: string;
    },
  ) {
    const template = await this.refs.getActiveTemplate(
      input.companyId,
      input.letterType,
      tx,
    );
    if (!template) {
      throw new ConflictException({
        message: `No active ${input.letterType} letter template exists. Create one first.`,
        missingTemplateType: input.letterType,
      });
    }

    const body = renderTemplate(template.bodyTemplate, input.values);
    const pdf = await renderPdf(
      `${input.letterType.toUpperCase()} LETTER`,
      body,
    );
    const ref = await this.storage.put(
      LETTER_NAMESPACE,
      pdf,
      'application/pdf',
    );

    // Supersede the prior current letter of this type for this subject.
    const subjectWhere: Prisma.GeneratedLetterWhereInput = {
      companyId: input.companyId,
      letterType: input.letterType,
      isSuperseded: false,
      ...(input.employeeId ? { employeeId: input.employeeId } : {}),
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    };
    const prior = await tx.generatedLetter.findFirst({
      where: subjectWhere,
      orderBy: { version: 'desc' },
    });
    if (prior) {
      await tx.generatedLetter.update({
        where: { id: prior.id },
        data: { isSuperseded: true },
      });
    }

    const letter = await tx.generatedLetter.create({
      data: {
        companyId: input.companyId,
        letterType: input.letterType,
        employeeId: input.employeeId,
        candidateId: input.candidateId,
        templateId: template.id,
        renderedRef: ref,
        version: (prior?.version ?? 0) + 1,
        issuedBy: caller.id,
      },
    });

    await this.auditLog.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.CREATE,
      entityId: letter.id,
      accountId: caller.id,
      companyId: input.companyId,
      ipAddress: input.ipAddress,
    });
    return letter;
  }
}
