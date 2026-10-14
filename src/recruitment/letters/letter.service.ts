import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  IssuedLetter,
  Prisma,
  ResignationStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { SIGNATORY_REQUIRED } from '../../letters/letter-error-codes';
import { LettersService } from '../../letters/letters.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { LetterKindsService } from '../../settings/letter-kinds/letter-kinds.service';
import { SignatoriesService } from '../../settings/signatories/signatories.service';
import { RecruitmentRefsService } from '../recruitment-refs.service';

/** `14 Oct 2026` — the way the letters records print a date. */
const letterDate = (d: Date | null | undefined): string =>
  d
    ? d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '';

/**
 * Where a standard template's token goes by a different name from the value this path has
 * always computed. `postOffered` is the offer letter's word for the designation; the
 * experience and relieving letters' end date is the old path's last working day.
 */
const LEGACY_ALIASES: Record<string, string> = {
  postOffered: 'designation',
  noticeDays: 'noticePeriodDays',
  fromDate: 'dateOfJoining',
  contractStartDate: 'dateOfJoining',
  toDate: 'lastWorkingDay',
  relievingDate: 'lastWorkingDay',
};

/** What a caller may add to a recruitment letter: typed values and who signs. */
export interface RecruitmentLetterOptions {
  variables?: Record<string, string>;
  signatoryId?: string;
}

/**
 * Recruitment's letters — the offer letter, and the appointment, confirmation, relieving and
 * experience letters raised from the employee screens.
 *
 * ## One renderer (2026-10-14)
 *
 * This service used to render its own PDFs: a pdfkit page with the kind's key as a title and
 * the body underneath, on plain paper, with no reference number and no signature. Meanwhile
 * `src/letters` grew the real thing — the company's letterhead, a reference from the
 * company's series, the signatory's graphic, and fields pre-filled from the employee and
 * candidate records. Two renderers meant two different-looking documents for the same kind,
 * depending on which screen somebody clicked.
 *
 * Both entry points now **delegate to `LettersService.compose`**, which is the single place a
 * letter is rendered. What stays here is what recruitment owns and the frontend relies on:
 *
 * - the endpoints and their response shapes (the raw `IssuedLetter` row from `POST letters`,
 *   the id `Offer.letterId` points at, the `letters/:id/download` stream);
 * - the relieving-needs-a-processed-F&F gate;
 * - one current letter per kind per person: a new one supersedes the previous one and takes
 *   the next version number, as it always has here.
 *
 * The values the old path computed are still passed — as overrides, and **only for tokens the
 * records leave blank** — so a letter that could be generated before still can be wherever
 * the old path knew the answer and the new records do not (an experience letter's end date
 * taken from the accepted resignation before there is an exit record, say).
 *
 * The signatory is the caller's choice when given, else the company's first active
 * signatory. A company with none is refused with a message that names where to add one.
 */
@Injectable()
export class LetterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly storage: StorageService,
    private readonly refs: RecruitmentRefsService,
    private readonly kinds: LetterKindsService,
    private readonly letters: LettersService,
    private readonly signatories: SignatoriesService,
  ) {}

  async findAll(
    caller: AuthenticatedUser,
    query: { companyId?: string; letterType?: string; employeeId?: string },
  ) {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.issuedLetter.findMany({
          where: {
            ...companyScope(caller, query.companyId),
            ...(query.letterType
              ? { letterKind: { key: query.letterType } }
              : {}),
            ...(query.employeeId ? { employeeId: query.employeeId } : {}),
            // Composed-but-unissued letters are 017's, not Recruitment's. Excluding
            // them keeps this list exactly what it was before the restructure.
            issuedAt: { not: null },
          },
          include: { letterKind: { select: { key: true } } },
          orderBy: [{ issuedAt: 'desc' }],
        }),
    );
    return rows.map((r) => ({
      id: r.id,
      letterType: r.letterKind.key,
      employeeId: r.employeeId,
      candidateId: r.candidateId,
      version: r.version,
      isSuperseded: r.isSuperseded,
      issuedAt: r.issuedAt?.toISOString() ?? null,
    }));
  }

  /** Generates a letter for an employee (appointment/confirmation/relieving/experience). */
  async generateForEmployee(
    caller: AuthenticatedUser,
    dto: { letterType: string; employeeId: string } & RecruitmentLetterOptions,
    _ipAddress: string,
  ): Promise<IssuedLetter> {
    const companyId = companyScope(caller).companyId;
    if (!companyId) {
      // A 400, not a 404: the company is not missing — the caller never named one.
      // A cross-company Super Admin has no `companyId` of their own for
      // `companyScope()` to fall back on, so a write from them must say which
      // company it belongs to. Same message every other module uses for this case.
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }

    if (dto.letterType === 'relieving') {
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
    if (dto.letterType === 'relieving' || dto.letterType === 'experience') {
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
      lastWorkingDay = letterDate(lwd);
      if (employee.dateOfJoining && lwd) {
        const months =
          (lwd.getFullYear() - employee.dateOfJoining.getFullYear()) * 12 +
          (lwd.getMonth() - employee.dateOfJoining.getMonth());
        tenure = `${Math.max(0, months)} months`;
      }
    }

    const legacy: Record<string, string> = {
      employeeName: [employee.firstName, employee.lastName]
        .filter(Boolean)
        .join(' '),
      employeeCode: employee.employeeCode,
      designation,
      department,
      dateOfJoining: letterDate(employee.dateOfJoining),
      confirmationDate: letterDate(employee.confirmationDate),
      lastWorkingDay,
      tenure,
      companyName,
      issueDate: letterDate(new Date()),
    };

    return this.issue(caller, {
      companyId,
      letterType: dto.letterType,
      recipient: { employeeId: dto.employeeId },
      legacy,
      options: dto,
    });
  }

  /**
   * Generates the offer letter for an offer (called from the offer flow) and returns its id,
   * which the offer stores as `letterId`.
   *
   * **Not inside the offer's transaction any more.** `compose` commits the letter in its own
   * transactions — it has to: it allocates the reference, renders the PDF and writes it to
   * storage — so the offer flow calls this between validating the offer and issuing it.
   */
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
    _ipAddress: string,
    options: RecruitmentLetterOptions = {},
  ): Promise<string> {
    const candidate = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.candidate.findUnique({
          where: { id: offer.candidateId },
          select: { fullName: true },
        }),
    );
    const companyName = await this.refs.companyName(offer.companyId);
    const designation = await this.refs.designationName(
      caller,
      offer.designationId,
    );
    const department = await this.refs.departmentName(
      caller,
      offer.departmentId,
    );

    const legacy: Record<string, string> = {
      candidateName: candidate?.fullName ?? '',
      designation,
      department,
      offeredCtc: offer.offeredCtc.toNumber().toLocaleString('en-IN'),
      joiningDate: letterDate(
        offer.confirmedJoiningDate ?? offer.proposedJoiningDate,
      ),
      probationMonths: String(offer.probationMonths),
      noticePeriodDays: String(offer.noticePeriodDays),
      companyName,
      issueDate: letterDate(new Date()),
    };

    const letter = await this.issue(caller, {
      companyId: offer.companyId,
      letterType: 'offer',
      recipient: { candidateId: offer.candidateId },
      legacy,
      options,
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
      (tx) =>
        tx.issuedLetter.findUnique({
          where: { id: letterId },
          include: { letterKind: { select: { key: true } } },
        }),
    );
    if (!letter) throw new NotFoundException(`Letter ${letterId} not found`);
    assertInScope(caller, letter, `Letter ${letterId}`);
    if (!letter.renderedRef) {
      throw new ConflictException(
        'This letter has been composed but not issued, so there is no document yet.',
      );
    }
    const buffer = await this.storage.get(letter.renderedRef);
    await this.auditLog.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.READ,
      entityId: letterId,
      accountId: caller.id,
      companyId: letter.companyId,
      ipAddress,
    });
    return {
      buffer,
      filename: `${letter.letterKind.key}-v${letter.version}.pdf`,
    };
  }

  /**
   * Composes and issues through `LettersService`, then supersedes the person's previous
   * letter of the kind, returning the new row as this module has always returned it.
   */
  private async issue(
    caller: AuthenticatedUser,
    input: {
      companyId: string;
      letterType: string;
      recipient: { employeeId?: string; candidateId?: string };
      legacy: Record<string, string>;
      options: RecruitmentLetterOptions;
    },
  ): Promise<IssuedLetter> {
    const ctx = rlsContextFor(caller);
    const kind = await this.kinds.requireByKey(
      ctx,
      input.companyId,
      input.letterType,
    );
    const signatoryId = kind.requiresSignature
      ? input.options.signatoryId ??
        (await this.defaultSignatory(caller, input.companyId, kind.label))
      : undefined;

    const variables = {
      ...(await this.legacyOverrides(caller, input)),
      ...(input.options.variables ?? {}),
    };

    const composed = await this.letters.compose(caller, {
      letterKindKey: input.letterType,
      ...input.recipient,
      signatoryId,
      variables,
    });

    return withRlsContext(this.prisma, ctx, async (tx) => {
      // One current letter per kind per person, numbered in sequence — what this list has
      // always shown. Only issued letters count: a composed draft from 017's own screen is
      // not a letter the person was sent.
      const prior = await tx.issuedLetter.findMany({
        where: {
          companyId: input.companyId,
          letterKindId: kind.id,
          id: { not: composed.id },
          issuedAt: { not: null },
          ...(input.recipient.employeeId
            ? { employeeId: input.recipient.employeeId }
            : { candidateId: input.recipient.candidateId }),
        },
        select: { id: true, version: true, isSuperseded: true },
      });
      const current = prior.filter((row) => !row.isSuperseded);
      if (current.length > 0) {
        await tx.issuedLetter.updateMany({
          where: { id: { in: current.map((row) => row.id) } },
          data: { isSuperseded: true },
        });
      }
      const version = Math.max(0, ...prior.map((row) => row.version)) + 1;
      return tx.issuedLetter.update({
        where: { id: composed.id },
        data: { version },
      });
    });
  }

  /**
   * The old path's values, for the tokens the records leave blank.
   *
   * Never over a value a record supplies: the records are the source of truth for pre-fill,
   * and this path's `designation` or `dateOfJoining` are the same facts read a different way.
   * A token the kind does not declare at all — a company's own confirmation template written
   * against the old token names — gets the old value, which is exactly what it rendered with
   * before.
   */
  private async legacyOverrides(
    caller: AuthenticatedUser,
    input: {
      letterType: string;
      recipient: { employeeId?: string; candidateId?: string };
      legacy: Record<string, string>;
    },
  ): Promise<Record<string, string>> {
    const prefill = await this.letters.prefill(caller, {
      letterKindKey: input.letterType,
      ...input.recipient,
    });
    const known = new Map(prefill.fields.map((f) => [f.token, f.value]));

    const offered: Record<string, string> = { ...input.legacy };
    for (const [token, legacyKey] of Object.entries(LEGACY_ALIASES)) {
      const value = input.legacy[legacyKey];
      if (value && offered[token] === undefined) offered[token] = value;
    }

    const overrides: Record<string, string> = {};
    for (const [token, value] of Object.entries(offered)) {
      if (!value) continue;
      const fromRecords = known.get(token);
      if (fromRecords === undefined || fromRecords.trim() === '') {
        overrides[token] = value;
      }
    }
    return overrides;
  }

  /** The company's first active signatory, or a refusal that says where to add one. */
  private async defaultSignatory(
    caller: AuthenticatedUser,
    companyId: string,
    kindLabel: string,
  ): Promise<string> {
    const [first] = await this.signatories.listFor(
      rlsContextFor(caller),
      companyId,
    );
    if (first) return first.id;
    throw new BadRequestException({
      statusCode: 400,
      code: SIGNATORY_REQUIRED,
      message:
        `A ${kindLabel} carries a signature, and this company has no active signatory. ` +
        'Add one under Settings → Signatories, then generate the letter again.',
    });
  }
}
