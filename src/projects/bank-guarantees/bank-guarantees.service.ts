import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  BankGuarantee,
  BankGuaranteeStatus,
  BankGuaranteeType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { actorNamesFor } from '../../common/actor-name';
import type { SettingsConfig } from '../../common/configs/config.interface';
import * as ExcelJS from 'exceljs';

import {
  FORM_CONTENT_TYPES,
  FormCell,
  FormFormat,
  FormRow,
  RenderedForm,
  renderFormFile,
} from '../../common/form-document';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { describeStoredFile } from '../../common/storage/file-type';
import { StorageService } from '../../common/storage/storage.service';
import {
  assertAllowedFileType,
  compressImageUpload,
  DOCUMENT_TYPES,
} from '../../common/uploads';
import { zonedDateOnly } from '../../hr/leave/leave-days';
import { CompaniesService } from '../../settings/companies/companies.service';
import { companyScope } from '../../settings/company-scope';
import {
  BG_STATUS_LABEL,
  daysToExpiry,
  displayStatus,
  guaranteeDateErrors,
} from './bank-guarantee.rules';
import {
  BgStatusFilter,
  CreateBankGuaranteeDto,
  CreateBgTenderDto,
  EncashBankGuaranteeDto,
  ExportBgTendersDto,
  ExtendBankGuaranteeDto,
  ListBgTendersDto,
  ReleaseBankGuaranteeDto,
  ReopenBankGuaranteeDto,
  UpdateBankGuaranteeDto,
  UpdateBgTenderDto,
} from './dto/bank-guarantee.dto';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** The client's alert window; the register's "Expiring" filter uses the same 30 days. */
export const BG_EXPIRY_WINDOW_DAYS = 30;

/** A refusal code the web shows against the BG number field. */
export const BG_NUMBER_TAKEN = 'BG_NUMBER_TAKEN';
/** Released or encashed: the record is final until reopened. */
export const BG_NOT_RUNNING = 'BG_NOT_RUNNING';

const GUARANTEE_INCLUDE = {
  documents: { orderBy: { uploadedAt: 'desc' } },
  events: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.BankGuaranteeInclude;

type GuaranteeRow = Prisma.BankGuaranteeGetPayload<{
  include: typeof GUARANTEE_INCLUDE;
}>;

/** `YYYY-MM-DD` (or a full ISO string) → the UTC midnight a `@db.Date` column stores. */
function dateOnly(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`);
}

function optionalDate(
  value: string | null | undefined,
): Date | null | undefined {
  if (value === undefined) return undefined;
  return value ? dateOnly(value) : null;
}

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** "28.04.2026" — the client's sheet writes dates with dots. */
function dotted(value: Date | null): string {
  if (!value) return '';
  const iso = value.toISOString();
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

function blankToNull(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The Bank Guarantees register (037, specs/037-bank-guarantees/spec.md).
 *
 * A tender is entered once and its EMD and PBG guarantees sit under it, because the client's
 * register pairs them on one row per tender. Each guarantee carries its own documents and a
 * history; "Expired" is derived from the dates (`displayStatus`), never stored.
 */
@Injectable()
export class BankGuaranteesService {
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLog: AuditLogService,
    private readonly companies: CompaniesService,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
  }

  private today(): string {
    return zonedDateOnly(new Date(), this.timeZone);
  }

  private targetCompanyOf(
    caller: AuthenticatedUser,
    requested?: string,
  ): string {
    const scope = companyScope(caller, requested);
    const companyId = scope.companyId ?? caller.companyId;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  // ── The register ───────────────────────────────────────────────────────────

  /** Guarantees in a state, as a `where` on `BankGuarantee` (`today` is a business date). */
  private statusWhere(
    status: BgStatusFilter,
    today: string,
  ): Prisma.BankGuaranteeWhereInput {
    const day = dateOnly(today);
    const horizon = new Date(
      day.getTime() + BG_EXPIRY_WINDOW_DAYS * MS_PER_DAY,
    );
    const running = BankGuaranteeStatus.RUNNING;
    switch (status) {
      case 'released':
        return { status: BankGuaranteeStatus.RELEASED };
      case 'encashed':
        return { status: BankGuaranteeStatus.ENCASHED };
      case 'expired':
        return {
          status: running,
          OR: [
            { claimPeriodEndDate: { lt: day } },
            { claimPeriodEndDate: null, expiryDate: { lt: day } },
          ],
        };
      case 'expiring':
        // Within 30 days, or already past and not yet dealt with — the same set the alert holds.
        return {
          status: running,
          OR: [
            { claimPeriodEndDate: { lte: horizon } },
            { claimPeriodEndDate: null, expiryDate: { lte: horizon } },
          ],
        };
      case 'running':
        return {
          status: running,
          OR: [
            { claimPeriodEndDate: { gte: day } },
            { claimPeriodEndDate: null, expiryDate: { gte: day } },
            { claimPeriodEndDate: null, expiryDate: null },
          ],
        };
    }
  }

  private tenderWhere(
    caller: AuthenticatedUser,
    query: ExportBgTendersDto,
    today: string,
  ): Prisma.BgTenderWhereInput {
    const search = query.search?.trim();
    return {
      // The company the header serves, as the employee list does: a Super Admin who has not
      // chosen one sees their own company's register, not every company's tenders numbered 1, 1, 2, 2.
      companyId: this.targetCompanyOf(caller, query.companyId),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.status
        ? { guarantees: { some: this.statusWhere(query.status, today) } }
        : {}),
      ...(search
        ? {
            OR: [
              { workName: { contains: search, mode: 'insensitive' } },
              { departmentName: { contains: search, mode: 'insensitive' } },
              {
                guarantees: {
                  some: {
                    OR: [
                      { bgNumber: { contains: search, mode: 'insensitive' } },
                      {
                        issuingBank: { contains: search, mode: 'insensitive' },
                      },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
  }

  async list(caller: AuthenticatedUser, query: ListBgTendersDto) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
    const today = this.today();
    const where = this.tenderWhere(caller, query, today);

    const [rows, total] = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        Promise.all([
          tx.bgTender.findMany({
            where,
            orderBy: { serialNo: 'asc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
            include: {
              project: { select: { id: true, name: true } },
              guarantees: {
                orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
                include: { _count: { select: { documents: true } } },
              },
            },
          }),
          tx.bgTender.count({ where }),
        ]),
    );

    return {
      items: rows.map((tender) => ({
        ...this.tenderView(tender),
        guarantees: tender.guarantees.map((bg) => ({
          ...this.guaranteeSummary(bg, today),
          documentCount: bg._count.documents,
        })),
      })),
      total,
      page,
      pageSize,
    };
  }

  async findOne(caller: AuthenticatedUser, id: string) {
    const today = this.today();
    const tender = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.bgTender.findFirst({
          where: { id, ...companyScope(caller) },
          include: {
            project: { select: { id: true, name: true } },
            guarantees: {
              orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
              include: GUARANTEE_INCLUDE,
            },
          },
        }),
    );
    if (!tender) throw new NotFoundException('Tender not found.');

    const names = await actorNamesFor(this.prisma, [
      tender.createdByUserId,
      ...tender.guarantees.flatMap((bg) => [
        ...bg.documents.map((d) => d.uploadedByUserId),
        ...bg.events.map((e) => e.actorUserId),
      ]),
    ]);

    return {
      ...this.tenderView(tender),
      guarantees: tender.guarantees.map((bg) =>
        this.guaranteeDetail(bg, today, names),
      ),
    };
  }

  private tenderView(tender: {
    id: string;
    companyId: string;
    serialNo: number;
    workName: string;
    departmentName: string;
    tenderAmount: Prisma.Decimal | null;
    projectId: string | null;
    project: { id: string; name: string } | null;
    remarks: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: tender.id,
      companyId: tender.companyId,
      serialNo: tender.serialNo,
      workName: tender.workName,
      departmentName: tender.departmentName,
      tenderAmount: tender.tenderAmount?.toFixed(2) ?? null,
      projectId: tender.projectId,
      projectName: tender.project?.name ?? null,
      remarks: tender.remarks,
      createdAt: tender.createdAt,
      updatedAt: tender.updatedAt,
    };
  }

  private guaranteeSummary(bg: BankGuarantee, today: string) {
    return {
      id: bg.id,
      tenderId: bg.tenderId,
      type: bg.type,
      bgNumber: bg.bgNumber,
      amount: bg.amount.toFixed(2),
      issueDate: isoDate(bg.issueDate),
      expiryDate: isoDate(bg.expiryDate),
      claimPeriodEndDate: isoDate(bg.claimPeriodEndDate),
      issuingBank: bg.issuingBank,
      issuingBranch: bg.issuingBranch,
      marginAmount: bg.marginAmount?.toFixed(2) ?? null,
      fdReference: bg.fdReference,
      status: bg.status,
      displayStatus: displayStatus(bg, today),
      daysToExpiry:
        bg.status === BankGuaranteeStatus.RUNNING
          ? daysToExpiry(bg, today)
          : null,
      releasedOn: isoDate(bg.releasedOn),
      encashedOn: isoDate(bg.encashedOn),
      encashedAmount: bg.encashedAmount?.toFixed(2) ?? null,
      remarks: bg.remarks,
    };
  }

  private guaranteeDetail(
    bg: GuaranteeRow,
    today: string,
    names: Map<string, string>,
  ) {
    return {
      ...this.guaranteeSummary(bg, today),
      documents: bg.documents.map((doc) => ({
        id: doc.id,
        title: doc.title,
        fileName: doc.fileName,
        contentType: doc.contentType,
        sizeBytes: doc.sizeBytes,
        uploadedAt: doc.uploadedAt,
        uploadedByName: names.get(doc.uploadedByUserId) ?? null,
      })),
      events: bg.events.map((event) => ({
        id: event.id,
        kind: event.kind,
        fromDate: isoDate(event.fromDate),
        toDate: isoDate(event.toDate),
        note: event.note,
        createdAt: event.createdAt,
        actorName: names.get(event.actorUserId) ?? null,
      })),
    };
  }

  // ── Tenders ────────────────────────────────────────────────────────────────

  private async assertProjectInCompany(
    tx: Prisma.TransactionClient,
    companyId: string,
    projectId: string | null | undefined,
  ): Promise<void> {
    if (!projectId) return;
    const project = await tx.project.findFirst({
      where: { id: projectId, companyId },
      select: { id: true },
    });
    if (!project)
      throw new BadRequestException('That project is not in this company.');
  }

  async createTender(
    caller: AuthenticatedUser,
    dto: CreateBgTenderDto,
    ipAddress: string,
    companyId?: string,
  ) {
    const targetCompanyId = this.targetCompanyOf(caller, companyId);
    const create = () =>
      withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
        await this.assertProjectInCompany(tx, targetCompanyId, dto.projectId);
        // The register's Sr. No. Two saves racing for the same number meet the unique index and
        // the loser retries below — rarer and simpler than a series row for one counter.
        const last = await tx.bgTender.aggregate({
          where: { companyId: targetCompanyId },
          _max: { serialNo: true },
        });
        return tx.bgTender.create({
          data: {
            companyId: targetCompanyId,
            serialNo: (last._max.serialNo ?? 0) + 1,
            workName: dto.workName.trim(),
            departmentName: dto.departmentName.trim(),
            tenderAmount: dto.tenderAmount ?? null,
            projectId: dto.projectId || null,
            remarks: blankToNull(dto.remarks) ?? null,
            createdByUserId: caller.id,
          },
        });
      });

    let created;
    try {
      created = await create();
    } catch (error) {
      if (
        !(
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
      ) {
        throw error;
      }
      created = await create();
    }

    await this.auditLog.record({
      entityType: AuditEntityType.BANK_GUARANTEE,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      changes: {
        tender: created.workName.slice(0, 120),
        serialNo: created.serialNo,
      },
      ipAddress,
    });
    return this.findOne(caller, created.id);
  }

  private async tenderOf(
    caller: AuthenticatedUser,
    tx: Prisma.TransactionClient,
    id: string,
  ) {
    const tender = await tx.bgTender.findFirst({
      where: { id, ...companyScope(caller) },
    });
    if (!tender) throw new NotFoundException('Tender not found.');
    return tender;
  }

  async updateTender(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateBgTenderDto,
    ipAddress: string,
  ) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const tender = await this.tenderOf(caller, tx, id);
        if (dto.projectId !== undefined) {
          await this.assertProjectInCompany(
            tx,
            tender.companyId,
            dto.projectId,
          );
        }
        return tx.bgTender.update({
          where: { id },
          data: {
            ...(dto.workName !== undefined
              ? { workName: dto.workName.trim() }
              : {}),
            ...(dto.departmentName !== undefined
              ? { departmentName: dto.departmentName.trim() }
              : {}),
            ...(dto.tenderAmount !== undefined
              ? { tenderAmount: dto.tenderAmount || null }
              : {}),
            ...(dto.projectId !== undefined
              ? { projectId: dto.projectId || null }
              : {}),
            ...(dto.remarks !== undefined
              ? { remarks: blankToNull(dto.remarks) }
              : {}),
          },
        });
      },
    );
    await this.auditLog.record({
      entityType: AuditEntityType.BANK_GUARANTEE,
      action: AuditAction.UPDATE,
      entityId: updated.id,
      accountId: caller.id,
      companyId: updated.companyId,
      changes: { ...dto } as Prisma.InputJsonValue,
      ipAddress,
    });
    return this.findOne(caller, id);
  }

  /** Only an empty tender: its guarantees are records somebody may be asked about. */
  async removeTender(caller: AuthenticatedUser, id: string, ipAddress: string) {
    const tender = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const found = await this.tenderOf(caller, tx, id);
        const count = await tx.bankGuarantee.count({ where: { tenderId: id } });
        if (count > 0) {
          throw new ConflictException(
            `This tender has ${count} bank guarantee${
              count === 1 ? '' : 's'
            }. Delete them first.`,
          );
        }
        await tx.bgTender.delete({ where: { id } });
        return found;
      },
    );
    await this.auditLog.record({
      entityType: AuditEntityType.BANK_GUARANTEE,
      action: AuditAction.DELETE,
      entityId: id,
      accountId: caller.id,
      companyId: tender.companyId,
      changes: {
        tender: tender.workName.slice(0, 120),
        serialNo: tender.serialNo,
      },
      ipAddress,
    });
    return { deleted: true };
  }

  // ── Guarantees ─────────────────────────────────────────────────────────────

  private assertDates(input: {
    bgNumber?: string | null;
    issueDate?: string | null;
    expiryDate?: string | null;
    claimPeriodEndDate?: string | null;
  }): void {
    const errors = guaranteeDateErrors(input);
    if (errors.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'BG_DATES_INVALID',
        message: errors[0],
        errors,
      });
    }
  }

  /** A BG number names one instrument; the partial unique index is the backstop. */
  private numberTaken(bgNumber: string): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: BG_NUMBER_TAKEN,
      message: `BG number ${bgNumber} is already recorded.`,
    });
  }

  private async withNumberCheck<T>(
    bgNumber: string | null | undefined,
    run: () => Promise<T>,
  ) {
    try {
      return await run();
    } catch (error) {
      if (
        bgNumber &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw this.numberTaken(bgNumber);
      }
      throw error;
    }
  }

  private async guaranteeOf(
    caller: AuthenticatedUser,
    tx: Prisma.TransactionClient,
    id: string,
  ) {
    const bg = await tx.bankGuarantee.findFirst({
      where: { id, ...companyScope(caller) },
    });
    if (!bg) throw new NotFoundException('Bank guarantee not found.');
    return bg;
  }

  private assertRunning(bg: BankGuarantee): void {
    if (bg.status !== BankGuaranteeStatus.RUNNING) {
      throw new ConflictException({
        statusCode: 409,
        code: BG_NOT_RUNNING,
        message: `This guarantee is ${BG_STATUS_LABEL[
          bg.status
        ].toLowerCase()}. Reopen it to change it.`,
      });
    }
  }

  private async audit(
    caller: AuthenticatedUser,
    bg: { id: string; companyId: string },
    action: AuditAction,
    changes: Record<string, unknown>,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.BANK_GUARANTEE,
      action,
      entityId: bg.id,
      accountId: caller.id,
      companyId: bg.companyId,
      changes: changes as Prisma.InputJsonValue,
      ipAddress,
    });
  }

  async createGuarantee(
    caller: AuthenticatedUser,
    tenderId: string,
    dto: CreateBankGuaranteeDto,
    ipAddress: string,
  ) {
    const bgNumber = blankToNull(dto.bgNumber) ?? null;
    this.assertDates({ ...dto, bgNumber });
    const created = await this.withNumberCheck(bgNumber, () =>
      withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
        const tender = await this.tenderOf(caller, tx, tenderId);
        const bg = await tx.bankGuarantee.create({
          data: {
            companyId: tender.companyId,
            tenderId,
            type: dto.type,
            bgNumber,
            amount: dto.amount,
            issueDate: optionalDate(dto.issueDate) ?? null,
            expiryDate: optionalDate(dto.expiryDate) ?? null,
            claimPeriodEndDate: optionalDate(dto.claimPeriodEndDate) ?? null,
            issuingBank: blankToNull(dto.issuingBank) ?? null,
            issuingBranch: blankToNull(dto.issuingBranch) ?? null,
            marginAmount: dto.marginAmount || null,
            fdReference: blankToNull(dto.fdReference) ?? null,
            remarks: blankToNull(dto.remarks) ?? null,
            createdByUserId: caller.id,
          },
        });
        await tx.bankGuaranteeEvent.create({
          data: {
            companyId: bg.companyId,
            bankGuaranteeId: bg.id,
            kind: 'created',
            actorUserId: caller.id,
          },
        });
        return bg;
      }),
    );
    await this.audit(
      caller,
      created,
      AuditAction.CREATE,
      {
        type: created.type,
        bgNumber: created.bgNumber,
        amount: created.amount.toFixed(2),
      },
      ipAddress,
    );
    return this.findOne(caller, tenderId);
  }

  async updateGuarantee(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateBankGuaranteeDto,
    ipAddress: string,
  ) {
    const bgNumber = blankToNull(dto.bgNumber);
    const bg = await this.withNumberCheck(bgNumber, () =>
      withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
        const existing = await this.guaranteeOf(caller, tx, id);
        this.assertRunning(existing);
        // Checked against the record as it will be, not only the fields sent.
        const pick = (sent: string | null | undefined, stored: Date | null) =>
          sent !== undefined ? sent : isoDate(stored);
        this.assertDates({
          bgNumber: bgNumber !== undefined ? bgNumber : existing.bgNumber,
          issueDate: pick(dto.issueDate, existing.issueDate),
          expiryDate: pick(dto.expiryDate, existing.expiryDate),
          claimPeriodEndDate: pick(
            dto.claimPeriodEndDate,
            existing.claimPeriodEndDate,
          ),
        });
        const updated = await tx.bankGuarantee.update({
          where: { id },
          data: {
            ...(bgNumber !== undefined ? { bgNumber } : {}),
            ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
            ...(dto.issueDate !== undefined
              ? { issueDate: optionalDate(dto.issueDate) }
              : {}),
            ...(dto.expiryDate !== undefined
              ? { expiryDate: optionalDate(dto.expiryDate) }
              : {}),
            ...(dto.claimPeriodEndDate !== undefined
              ? { claimPeriodEndDate: optionalDate(dto.claimPeriodEndDate) }
              : {}),
            ...(dto.issuingBank !== undefined
              ? { issuingBank: blankToNull(dto.issuingBank) }
              : {}),
            ...(dto.issuingBranch !== undefined
              ? { issuingBranch: blankToNull(dto.issuingBranch) }
              : {}),
            ...(dto.marginAmount !== undefined
              ? { marginAmount: dto.marginAmount || null }
              : {}),
            ...(dto.fdReference !== undefined
              ? { fdReference: blankToNull(dto.fdReference) }
              : {}),
            ...(dto.remarks !== undefined
              ? { remarks: blankToNull(dto.remarks) }
              : {}),
          },
        });
        // A changed expiry is history worth keeping even when it came through Edit, not Extend.
        const expiryChanged =
          isoDate(existing.expiryDate) !== isoDate(updated.expiryDate);
        await tx.bankGuaranteeEvent.create({
          data: {
            companyId: updated.companyId,
            bankGuaranteeId: id,
            kind: 'edited',
            fromDate: expiryChanged ? existing.expiryDate : null,
            toDate: expiryChanged ? updated.expiryDate : null,
            actorUserId: caller.id,
          },
        });
        return updated;
      }),
    );
    await this.audit(caller, bg, AuditAction.UPDATE, { ...dto }, ipAddress);
    return this.findOne(caller, bg.tenderId);
  }

  async extend(
    caller: AuthenticatedUser,
    id: string,
    dto: ExtendBankGuaranteeDto,
    ipAddress: string,
  ) {
    const bg = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await this.guaranteeOf(caller, tx, id);
        this.assertRunning(existing);
        const newExpiry = dateOnly(dto.expiryDate);
        if (existing.expiryDate && newExpiry <= existing.expiryDate) {
          throw new BadRequestException(
            `The new expiry date must be after the current one (${dotted(
              existing.expiryDate,
            )}).`,
          );
        }
        if (existing.issueDate && newExpiry < existing.issueDate) {
          throw new BadRequestException(
            'The new expiry date cannot be before the issue date.',
          );
        }
        // A claim period that would now end before expiry has to move too.
        const claim =
          dto.claimPeriodEndDate !== undefined
            ? optionalDate(dto.claimPeriodEndDate)
            : existing.claimPeriodEndDate;
        if (claim && claim < newExpiry) {
          throw new BadRequestException(
            'The claim period end date would be before the new expiry date. Enter a new claim period end date as well.',
          );
        }
        const updated = await tx.bankGuarantee.update({
          where: { id },
          data: { expiryDate: newExpiry, claimPeriodEndDate: claim ?? null },
        });
        await tx.bankGuaranteeEvent.create({
          data: {
            companyId: updated.companyId,
            bankGuaranteeId: id,
            kind: 'extended',
            fromDate: existing.expiryDate,
            toDate: newExpiry,
            note: dto.note?.trim() || null,
            actorUserId: caller.id,
          },
        });
        return { updated, from: existing.expiryDate };
      },
    );
    await this.audit(
      caller,
      bg.updated,
      AuditAction.UPDATE,
      {
        extended: { from: isoDate(bg.from), to: dto.expiryDate.slice(0, 10) },
      },
      ipAddress,
    );
    return this.findOne(caller, bg.updated.tenderId);
  }

  async release(
    caller: AuthenticatedUser,
    id: string,
    dto: ReleaseBankGuaranteeDto,
    ipAddress: string,
  ) {
    return this.close(
      caller,
      id,
      ipAddress,
      'released',
      dto.note,
      (existing) => {
        const releasedOn = dateOnly(dto.releasedOn);
        if (existing.issueDate && releasedOn < existing.issueDate) {
          throw new BadRequestException(
            'The release date cannot be before the issue date.',
          );
        }
        return { status: BankGuaranteeStatus.RELEASED, releasedOn };
      },
    );
  }

  async encash(
    caller: AuthenticatedUser,
    id: string,
    dto: EncashBankGuaranteeDto,
    ipAddress: string,
  ) {
    return this.close(
      caller,
      id,
      ipAddress,
      'encashed',
      dto.note,
      (existing) => {
        const amount = new Prisma.Decimal(dto.encashedAmount);
        if (amount.lte(0) || amount.gt(existing.amount)) {
          throw new BadRequestException(
            `The encashed amount must be more than zero and no more than the BG amount (${existing.amount.toFixed(
              2,
            )}).`,
          );
        }
        return {
          status: BankGuaranteeStatus.ENCASHED,
          encashedOn: dateOnly(dto.encashedOn),
          encashedAmount: amount,
        };
      },
    );
  }

  private async close(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
    kind: 'released' | 'encashed',
    note: string | undefined,
    change: (existing: BankGuarantee) => Prisma.BankGuaranteeUpdateInput,
  ) {
    const bg = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await this.guaranteeOf(caller, tx, id);
        this.assertRunning(existing);
        const updated = await tx.bankGuarantee.update({
          where: { id },
          data: change(existing),
        });
        await tx.bankGuaranteeEvent.create({
          data: {
            companyId: updated.companyId,
            bankGuaranteeId: id,
            kind,
            toDate: updated.releasedOn ?? updated.encashedOn,
            note: note?.trim() || null,
            actorUserId: caller.id,
          },
        });
        return updated;
      },
    );
    await this.audit(
      caller,
      bg,
      AuditAction.UPDATE,
      { status: bg.status },
      ipAddress,
    );
    return this.findOne(caller, bg.tenderId);
  }

  /** Back to Running — for a release or encashment recorded by mistake. The reason is kept. */
  async reopen(
    caller: AuthenticatedUser,
    id: string,
    dto: ReopenBankGuaranteeDto,
    ipAddress: string,
  ) {
    const bg = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await this.guaranteeOf(caller, tx, id);
        if (existing.status === BankGuaranteeStatus.RUNNING) {
          throw new ConflictException('This guarantee is already running.');
        }
        const updated = await tx.bankGuarantee.update({
          where: { id },
          data: {
            status: BankGuaranteeStatus.RUNNING,
            releasedOn: null,
            encashedOn: null,
            encashedAmount: null,
          },
        });
        await tx.bankGuaranteeEvent.create({
          data: {
            companyId: updated.companyId,
            bankGuaranteeId: id,
            kind: 'reopened',
            note: dto.note.trim(),
            actorUserId: caller.id,
          },
        });
        return updated;
      },
    );
    await this.audit(
      caller,
      bg,
      AuditAction.UPDATE,
      { status: 'RUNNING', reopened: dto.note },
      ipAddress,
    );
    return this.findOne(caller, bg.tenderId);
  }

  /** For a guarantee entered by mistake. Its documents go with it. */
  async removeGuarantee(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ) {
    const { bg, refs } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await this.guaranteeOf(caller, tx, id);
        const documents = await tx.bankGuaranteeDocument.findMany({
          where: { bankGuaranteeId: id },
          select: { fileRef: true },
        });
        await tx.bankGuarantee.delete({ where: { id } });
        return { bg: existing, refs: documents.map((d) => d.fileRef) };
      },
    );
    // After the row is gone: a failed storage delete leaves an orphan file, never a row
    // pointing at nothing.
    if (refs.length) await this.storage.deleteMany(refs).catch(() => undefined);
    await this.audit(
      caller,
      bg,
      AuditAction.DELETE,
      {
        type: bg.type,
        bgNumber: bg.bgNumber,
        amount: bg.amount.toFixed(2),
      },
      ipAddress,
    );
    return this.findOne(caller, bg.tenderId);
  }

  // ── Documents ──────────────────────────────────────────────────────────────

  async uploadDocument(
    caller: AuthenticatedUser,
    id: string,
    input: { title: string; data: Buffer; fileName?: string },
    ipAddress: string,
  ) {
    // The type comes from the bytes, not the request, and must be on the document allow-list
    // (PDF, images, xlsx, docx); a photo of a BG is stored compressed.
    const detected = assertAllowedFileType(
      input.data,
      DOCUMENT_TYPES,
      'The document',
    ).contentType;
    const image = await compressImageUpload(input.data, detected);
    const contentType = image?.main.contentType ?? detected;
    const data = image?.main.data ?? input.data;
    const fileName =
      input.fileName && image?.compressed && contentType !== detected
        ? `${input.fileName.replace(/\.[^./\\]+$/, '') || 'document'}.${
            contentType === 'image/webp' ? 'webp' : 'jpg'
          }`
        : input.fileName ?? null;

    const bg = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      this.guaranteeOf(caller, tx, id),
    );
    const fileRef = await this.storage.put(
      `bank-guarantees/${bg.companyId}`,
      data,
      contentType,
    );
    try {
      await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
        tx.bankGuaranteeDocument.create({
          data: {
            companyId: bg.companyId,
            bankGuaranteeId: id,
            title: input.title.trim(),
            fileRef,
            fileName,
            contentType,
            sizeBytes: data.length,
            uploadedByUserId: caller.id,
          },
        }),
      );
    } catch (error) {
      await this.storage.deleteMany([fileRef]).catch(() => undefined);
      throw error;
    }
    await this.audit(
      caller,
      bg,
      AuditAction.UPDATE,
      { documentAdded: input.title.trim() },
      ipAddress,
    );
    return this.findOne(caller, bg.tenderId);
  }

  async downloadDocument(caller: AuthenticatedUser, documentId: string) {
    const document = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.bankGuaranteeDocument.findFirst({
          where: { id: documentId, ...companyScope(caller) },
        }),
    );
    if (!document) throw new NotFoundException('Document not found.');
    const data = await this.storage.get(document.fileRef);
    const described = describeStoredFile({
      bytes: data,
      storedName: document.fileName,
      storedType: document.contentType,
      fallbackName: `${document.title.replace(/[^A-Za-z0-9._-]+/g, '-')}-${
        document.id
      }`,
    });
    return { data, ...described };
  }

  async removeDocument(
    caller: AuthenticatedUser,
    documentId: string,
    ipAddress: string,
  ) {
    const document = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const found = await tx.bankGuaranteeDocument.findFirst({
          where: { id: documentId, ...companyScope(caller) },
          include: {
            bankGuarantee: {
              select: { id: true, tenderId: true, companyId: true },
            },
          },
        });
        if (!found) throw new NotFoundException('Document not found.');
        await tx.bankGuaranteeDocument.delete({ where: { id: documentId } });
        return found;
      },
    );
    await this.storage.deleteMany([document.fileRef]).catch(() => undefined);
    await this.audit(
      caller,
      document.bankGuarantee,
      AuditAction.UPDATE,
      {
        documentRemoved: document.title,
      },
      ipAddress,
    );
    return this.findOne(caller, document.bankGuarantee.tenderId);
  }

  // ── The client's sheet ─────────────────────────────────────────────────────

  /**
   * "<COMPANY> TENDER BG DETAILS", in the client's columns: the tender, then its EMD and its PBG
   * side by side. A tender with more than one guarantee of a type takes one row per pair.
   *
   * Excel is laid out by hand (`registerWorkbook`), one column per field with a filter on every
   * header, because the client's sheet is filtered and sorted — the shared form renderer's merged
   * grid cannot be. The PDF keeps the form renderer, the tender's cells spanning its rows.
   */
  async export(
    caller: AuthenticatedUser,
    query: ExportBgTendersDto,
    format: FormFormat,
  ): Promise<RenderedForm> {
    const companyId = this.targetCompanyOf(caller, query.companyId);
    const today = this.today();
    const [tenders, identity] = await Promise.all([
      withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
        tx.bgTender.findMany({
          where: this.tenderWhere(caller, { ...query, companyId }, today),
          orderBy: { serialNo: 'asc' },
          include: { guarantees: { orderBy: { createdAt: 'asc' } } },
        }),
      ),
      this.companies.getDocumentIdentity(companyId),
    ]);

    if (format === 'xlsx') {
      return {
        bytes: await registerWorkbook(identity.name, tenders, today),
        contentType: FORM_CONTENT_TYPES.xlsx,
        filename: `Tender BG Details ${dotted(dateOnly(today))}.xlsx`,
      };
    }

    const RED = 'FFC7CE';
    const AMBER = 'FFEB9C';
    const money = (value: Prisma.Decimal | null) =>
      value
        ? Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })
        : '';
    const statusCell = (bg: BankGuarantee | undefined): FormCell => {
      if (!bg) return { text: '' };
      const shown = displayStatus(bg, today);
      const days = shown === 'RUNNING' ? daysToExpiry(bg, today) : null;
      return {
        text: BG_STATUS_LABEL[shown],
        align: 'center',
        fill:
          shown === 'EXPIRED'
            ? RED
            : days !== null && days <= BG_EXPIRY_WINDOW_DAYS
            ? AMBER
            : undefined,
      };
    };
    const half = (bg: BankGuarantee | undefined): FormRow =>
      bg
        ? [
            { text: money(bg.amount), align: 'right' },
            bg.bgNumber ?? '',
            { text: dotted(bg.issueDate), align: 'center' },
            { text: dotted(bg.expiryDate), align: 'center' },
            statusCell(bg),
          ]
        : ['', '', '', '', ''];

    const rows: FormRow[] = tenders.flatMap((tender) => {
      const emd = tender.guarantees.filter(
        (g) => g.type === BankGuaranteeType.EMD,
      );
      const pbg = tender.guarantees.filter(
        (g) => g.type === BankGuaranteeType.PBG,
      );
      const height = Math.max(1, emd.length, pbg.length);
      return Array.from({ length: height }, (_, i) => {
        const lead: FormRow =
          i === 0
            ? [
                {
                  text: String(tender.serialNo),
                  align: 'center',
                  rowSpan: height,
                },
                { text: tender.workName, rowSpan: height },
                {
                  text: tender.departmentName,
                  align: 'center',
                  rowSpan: height,
                },
                {
                  text: money(tender.tenderAmount),
                  align: 'right',
                  rowSpan: height,
                },
              ]
            : [];
        return [...lead, ...half(emd[i]), ...half(pbg[i])];
      });
    });

    const stem = `Tender BG Details ${dotted(dateOnly(today))}`;
    return renderFormFile(
      {
        company: {
          name: identity.name,
          address: identity.address,
          logo: identity.logo,
        },
        title: `${identity.name.toUpperCase()} TENDER BG DETAILS`,
        caption: `(As on ${dotted(dateOnly(today))})`,
        landscape: true,
        accent: 'amber',
        sheetName: 'Tender BG Details',
        footer:
          'Amber: expires within 30 days. Red: expired and not yet released.',
        blocks: [
          {
            kind: 'table',
            fontSize: 7,
            columns: [
              { label: 'Sr. No', width: 3, align: 'center' },
              { label: 'Work Name', width: 18 },
              { label: 'Department Name', width: 8, align: 'center' },
              { label: 'Tender Amount', width: 7, align: 'right' },
              { label: 'EMD BG Amount', width: 6, align: 'right' },
              { label: 'BG Number', width: 8 },
              { label: 'Issue Date', width: 5, align: 'center' },
              { label: 'Expiry Date', width: 5, align: 'center' },
              { label: 'Status', width: 5, align: 'center' },
              { label: 'PBG Amount', width: 6, align: 'right' },
              { label: 'BG Number', width: 8 },
              { label: 'Issue Date', width: 5, align: 'center' },
              { label: 'Expiry Date', width: 5, align: 'center' },
              { label: 'Status', width: 5, align: 'center' },
            ],
            rows,
            emptyText: 'No bank guarantees recorded.',
          },
        ],
      },
      format,
      stem,
    );
  }
}

/**
 * The client's "TENDER BG DETAILS" sheet (037): a yellow title row, then one header row with a
 * filter on every column — Sr. No, Work Name, Department Name, Tender Amount, then EMD and PBG
 * (amount, BG number, issue date, expiry date, status) side by side.
 *
 * Each row repeats its tender's cells rather than merging them, so filtering by department or
 * status keeps every guarantee's tender beside it. Amounts are numbers (Indian grouping), dates
 * are DD.MM.YYYY text as the client writes them. A status within the 30-day window is amber; an
 * expired one, not yet released, is red.
 */
async function registerWorkbook(
  companyName: string,
  tenders: Prisma.BgTenderGetPayload<{ include: { guarantees: true } }>[],
  today: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Tender BG Details', {
    views: [{ state: 'frozen', ySplit: 2 }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  const columns: {
    header: string;
    width: number;
    money?: boolean;
    center?: boolean;
  }[] = [
    { header: 'Sr. No', width: 7, center: true },
    { header: 'Work Name', width: 48 },
    { header: 'Department Name', width: 18, center: true },
    { header: 'Tender Amount', width: 16, money: true },
    { header: 'EMD BG Amount', width: 15, money: true },
    { header: 'BG Number', width: 20, center: true },
    { header: 'Issue Date', width: 12, center: true },
    { header: 'Expiry Date', width: 12, center: true },
    { header: 'Status', width: 11, center: true },
    { header: 'PBG Amount', width: 15, money: true },
    { header: 'BG Number', width: 20, center: true },
    { header: 'Issue Date', width: 12, center: true },
    { header: 'Expiry Date', width: 12, center: true },
    { header: 'Status', width: 11, center: true },
  ];
  sheet.columns = columns.map((c) => ({ width: c.width }));

  const thin = { style: 'thin' as const, color: { argb: 'FF7F7F7F' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  sheet.mergeCells(1, 1, 1, columns.length);
  const title = sheet.getCell(1, 1);
  title.value = `${companyName.toUpperCase()} TENDER BG DETAILS`;
  title.font = { bold: true, size: 14 };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  title.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFF00' },
  };
  sheet.getRow(1).height = 24;

  const header = sheet.getRow(2);
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFD966' },
    };
    cell.border = border;
  });
  header.height = 30;
  sheet.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: columns.length },
  };

  const half = (bg: BankGuarantee | undefined): (string | number | null)[] =>
    bg
      ? [
          Number(bg.amount),
          bg.bgNumber ?? '',
          dotted(bg.issueDate),
          dotted(bg.expiryDate),
          BG_STATUS_LABEL[displayStatus(bg, today)],
        ]
      : [null, '', '', '', ''];
  const tone = (bg: BankGuarantee | undefined): string | null => {
    if (!bg) return null;
    const shown = displayStatus(bg, today);
    if (shown === 'EXPIRED') return 'FFFFC7CE';
    const days = shown === 'RUNNING' ? daysToExpiry(bg, today) : null;
    return days !== null && days <= BG_EXPIRY_WINDOW_DAYS ? 'FFFFEB9C' : null;
  };

  for (const tender of tenders) {
    const emd = tender.guarantees.filter(
      (g) => g.type === BankGuaranteeType.EMD,
    );
    const pbg = tender.guarantees.filter(
      (g) => g.type === BankGuaranteeType.PBG,
    );
    const height = Math.max(1, emd.length, pbg.length);
    for (let i = 0; i < height; i++) {
      const row = sheet.addRow([
        tender.serialNo,
        tender.workName,
        tender.departmentName,
        tender.tenderAmount ? Number(tender.tenderAmount) : null,
        ...half(emd[i]),
        ...half(pbg[i]),
      ]);
      columns.forEach((c, index) => {
        const cell = row.getCell(index + 1);
        cell.border = border;
        cell.alignment = {
          vertical: 'middle',
          wrapText: true,
          horizontal: c.money ? 'right' : c.center ? 'center' : 'left',
        };
        if (c.money)
          cell.numFmt =
            '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00';
      });
      for (const [column, bg] of [
        [9, emd[i]],
        [14, pbg[i]],
      ] as const) {
        const fill = tone(bg);
        if (fill) {
          row.getCell(column).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: fill },
          };
        }
      }
    }
  }
  if (tenders.length === 0) {
    const row = sheet.addRow(['No bank guarantees recorded.']);
    sheet.mergeCells(row.number, 1, row.number, columns.length);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
