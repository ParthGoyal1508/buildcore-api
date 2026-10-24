import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CompanyBranch,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { canonicalStateName, gstStateCodeFor } from '../../common/gst-states';
import { withRlsContext } from '../../common/prisma/rls-context';
import {
  assertGstinFits,
  branchLabel,
  ensureHeadOffice,
  mirrorHeadOffice,
} from './company-branches';
import {
  BranchOptionDto,
  CompanyBranchDto,
  CreateCompanyBranchDto,
  UpdateCompanyBranchDto,
} from './dto/company-branch.dto';

/**
 * A company's branches — one per GST registration (041). Management only: the identity documents
 * print is read through `CompaniesService`, which every other module already holds.
 *
 * All writes run as system (`isSuperAdmin`) after the controller's `COMPANY_SETTINGS` +
 * `OwnCompanyGuard` have settled who may touch this company, exactly as company edits do.
 */
@Injectable()
export class CompanyBranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  static toDto(b: CompanyBranch): CompanyBranchDto {
    return {
      id: b.id,
      companyId: b.companyId,
      displayLabel: branchLabel(b),
      label: b.label,
      tradeName: b.tradeName,
      gstin: b.gstin,
      stateCode: gstStateCodeFor(b.state),
      address: b.address,
      city: b.city,
      state: b.state,
      pinCode: b.pinCode,
      phone: b.phone,
      email: b.email,
      website: b.website,
      pfEstablishmentCode: b.pfEstablishmentCode,
      esicCode: b.esicCode,
      professionalTaxRegNumber: b.professionalTaxRegNumber,
      isHeadOffice: b.isHeadOffice,
      isActive: b.isActive,
    };
  }

  /** Head office first, then by state and city. */
  async list(companyId: string): Promise<CompanyBranchDto[]> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      async (tx) => {
        await this.companyOrThrow(tx, companyId);
        await ensureHeadOffice(tx, companyId);
        return tx.companyBranch.findMany({
          where: { companyId },
          orderBy: [
            { isHeadOffice: 'desc' },
            { state: 'asc' },
            { city: 'asc' },
          ],
        });
      },
    );
    return rows.map(CompanyBranchesService.toDto);
  }

  async options(
    companyId: string,
    includeInactive = false,
  ): Promise<BranchOptionDto[]> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.companyBranch.findMany({
          where: { companyId, ...(includeInactive ? {} : { isActive: true }) },
          orderBy: [
            { isHeadOffice: 'desc' },
            { state: 'asc' },
            { city: 'asc' },
          ],
        }),
    );
    return rows.map((b) => ({
      id: b.id,
      label: branchLabel(b),
      gstin: b.gstin,
      state: b.state,
      isHeadOffice: b.isHeadOffice,
      isActive: b.isActive,
    }));
  }

  async create(
    caller: AuthenticatedUser,
    companyId: string,
    dto: CreateCompanyBranchDto,
    ipAddress: string,
  ): Promise<CompanyBranchDto> {
    const created = await this.write(async (tx) => {
      const company = await this.companyOrThrow(tx, companyId);
      await ensureHeadOffice(tx, companyId);
      const state = canonicalStateName(dto.state) ?? dto.state;
      assertGstinFits(dto.gstin, state, company.pan);
      return tx.companyBranch.create({
        data: {
          companyId,
          ...this.columns(dto),
          state,
          isHeadOffice: false,
          isActive: true,
        },
      });
    });
    await this.audit(caller, companyId, ipAddress, AuditAction.CREATE, {
      branch: created,
    });
    return CompanyBranchesService.toDto(created);
  }

  async update(
    caller: AuthenticatedUser,
    companyId: string,
    branchId: string,
    dto: UpdateCompanyBranchDto,
    ipAddress: string,
  ): Promise<CompanyBranchDto> {
    const { before, after } = await this.write(async (tx) => {
      const company = await this.companyOrThrow(tx, companyId);
      const existing = await this.branchOrThrow(tx, companyId, branchId);
      if (dto.isActive === false && existing.isHeadOffice) {
        throw new BadRequestException(
          'The head office cannot be deactivated; make another branch head office first.',
        );
      }
      const state =
        dto.state !== undefined
          ? canonicalStateName(dto.state) ?? dto.state
          : existing.state;
      const gstin = dto.gstin !== undefined ? dto.gstin : existing.gstin;
      // Re-checked whenever either side of the pairing moves, so changing a Gujarat branch's state
      // to Rajasthan without its GSTIN is refused just as entering the wrong GSTIN is.
      if (dto.gstin !== undefined || dto.state !== undefined) {
        assertGstinFits(gstin, state, company.pan);
      }
      const row = await tx.companyBranch.update({
        where: { id: branchId },
        data: {
          ...this.columns(dto),
          ...(dto.state !== undefined ? { state } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      if (row.isHeadOffice) await mirrorHeadOffice(tx, companyId);
      return { before: existing, after: row };
    });
    await this.audit(caller, companyId, ipAddress, AuditAction.UPDATE, {
      before,
      after,
    });
    return CompanyBranchesService.toDto(after);
  }

  /** Moves the head-office flag in one transaction and re-mirrors the company's columns. */
  async makeHeadOffice(
    caller: AuthenticatedUser,
    companyId: string,
    branchId: string,
    ipAddress: string,
  ): Promise<CompanyBranchDto[]> {
    const previous = await this.write(async (tx) => {
      await this.companyOrThrow(tx, companyId);
      const target = await this.branchOrThrow(tx, companyId, branchId);
      if (!target.isActive) {
        throw new BadRequestException(
          'An inactive branch cannot be the head office; reactivate it first.',
        );
      }
      const old = await ensureHeadOffice(tx, companyId);
      if (old.id === target.id) return old;
      // Unset first: the partial unique index allows only one head office at any moment.
      await tx.companyBranch.update({
        where: { id: old.id },
        data: { isHeadOffice: false },
      });
      await tx.companyBranch.update({
        where: { id: target.id },
        data: { isHeadOffice: true },
      });
      await mirrorHeadOffice(tx, companyId);
      return old;
    });
    await this.audit(caller, companyId, ipAddress, AuditAction.UPDATE, {
      headOffice: { from: previous.id, to: branchId },
    });
    return this.list(companyId);
  }

  private columns(dto: Partial<CreateCompanyBranchDto>) {
    const keys = [
      'label',
      'tradeName',
      'gstin',
      'address',
      'city',
      'pinCode',
      'phone',
      'email',
      'website',
      'pfEstablishmentCode',
      'esicCode',
      'professionalTaxRegNumber',
    ] as const;
    return Object.fromEntries(
      keys
        .filter((k) => dto[k] !== undefined)
        .map((k) => [k, dto[k] === '' ? null : dto[k]]),
    );
  }

  /** Runs a write as system, turning the GSTIN partial-unique violation into a 409. */
  private async write<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await withRlsContext(this.prisma, { isSuperAdmin: true }, fn);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Another branch of this company already has this GSTIN.',
        );
      }
      throw error;
    }
  }

  private async companyOrThrow(tx: Prisma.TransactionClient, id: string) {
    const company = await tx.company.findUnique({
      where: { id },
      select: { id: true, pan: true },
    });
    if (!company) throw new NotFoundException(`Company ${id} not found`);
    return company;
  }

  private async branchOrThrow(
    tx: Prisma.TransactionClient,
    companyId: string,
    branchId: string,
  ): Promise<CompanyBranch> {
    const branch = await tx.companyBranch.findFirst({
      where: { id: branchId, companyId },
    });
    if (!branch)
      throw new NotFoundException('Branch not found for this company.');
    return branch;
  }

  private audit(
    caller: AuthenticatedUser,
    companyId: string,
    ipAddress: string,
    action: AuditAction,
    changes: Record<string, unknown>,
  ) {
    return this.auditLog.record({
      entityType: AuditEntityType.COMPANY,
      action,
      entityId: companyId,
      changes: JSON.parse(JSON.stringify(changes)) as Prisma.InputJsonValue,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
