import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, AuditEntityType, Company, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import type { SettingsConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import { DocumentTypesService } from '../reference-data/document-types.service';
import { VendorCategoriesService } from '../vendor-categories/vendor-categories.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

/** FR-004's uniqueness rule is case-insensitive and trimmed; normalizing on write
 * makes "dc", " DC " and "Dc" the same code, and keeps the value consistent with the
 * `DC-0001` employee codes derived from it. A `lower()` unique index backs this at
 * the database level (20260829073000_settings_rls_policies). */
function normalizeShortCode(raw: string): string {
  return raw.trim().toUpperCase();
}

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditLog: AuditLogService,
    private readonly documentTypes: DocumentTypesService,
    private readonly vendorCategories: VendorCategoriesService,
  ) {}

  /**
   * The day-of-month after which attendance for the previous period is locked to
   * further edits.
   *
   * Exported for `hr`, which must reject a punch or leave application landing in an
   * already-locked period (FR-010). Principle I requires that read to be a service
   * call: `hr` may not query `settings.Company` itself.
   */
  async getPayrollLockDay(companyId: string): Promise<number> {
    const company = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.company.findUnique({
          where: { id: companyId },
          select: { payrollLockDay: true },
        }),
    );
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company.payrollLockDay;
  }

  /**
   * The BOCW cess rate as a fraction — 0.01 is 1% (007 FR-012).
   *
   * Exported for `partners`, whose cess liability is `contractValue × rate`. A
   * statutory percentage is exactly the kind of value Principle III keeps out of the
   * calculation that uses it: the rate is revisable by law, and a literal in
   * `BOCWService` would have to be found and changed under time pressure when it is.
   *
   * Returned as a number rather than a Decimal for the same reason the payroll rates
   * are — the consuming computation stays free of Prisma types.
   */
  async getBocwCessRate(companyId: string): Promise<number> {
    const company = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.company.findUnique({
          where: { id: companyId },
          select: { bocwCessRate: true },
        }),
    );
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return Number(company.bocwCessRate);
  }

  /**
   * The per-company payroll rates the engine applies (005 FR-014/FR-014a).
   *
   * Exported for `payroll` for the same reason `getPayrollLockDay` is exported for
   * `hr` — Principle I forbids either module from reading `settings.Company`
   * directly. Returned as numbers rather than Decimals so the engine's pure
   * computation stays free of Prisma types.
   */
  async getPayrollRates(companyId: string): Promise<{
    pfEmployerRate: number;
    esicEmployerRate: number;
    gratuityRate: number;
    bonusRate: number;
    otMultiplier: number;
  }> {
    const company = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.company.findUnique({
          where: { id: companyId },
          select: {
            pfEmployerRate: true,
            esicEmployerRate: true,
            gratuityRate: true,
            bonusRate: true,
            otMultiplier: true,
          },
        }),
    );
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return {
      pfEmployerRate: company.pfEmployerRate.toNumber(),
      esicEmployerRate: company.esicEmployerRate.toNumber(),
      gratuityRate: company.gratuityRate.toNumber(),
      bonusRate: company.bonusRate.toNumber(),
      otMultiplier: company.otMultiplier.toNumber(),
    };
  }

  /** Every company, whatever its status — the Settings UI's own admin list. Not the
   * source other modules' dropdowns read (see `listActiveForOtherModules`). */
  async findAll(): Promise<Company[]> {
    return this.prisma.company.findMany({ orderBy: { name: 'asc' } });
  }

  /**
   * Active companies only — exported from `SettingsModule` for any other module's
   * company-selection dropdown (FR-005). A deactivated company keeps all its data
   * and stays in the admin list above; it simply stops being selectable elsewhere.
   */
  async listActiveForOtherModules(): Promise<Company[]> {
    return this.prisma.company.findMany({
      where: { status: 'active' },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string): Promise<Company> {
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) {
      throw new NotFoundException(`Company ${id} not found`);
    }
    return company;
  }

  /**
   * Creates a company and everything a company cannot function without: its default
   * document types (FR-020) and its employee-code counter row (FR-023). All three
   * happen in one transaction — a company with no code sequence would fail the first
   * time anyone tried to create an employee under it.
   *
   * Omitted payroll rates fall back to `SettingsConfig` (FR-002, research.md §11)
   * and remain per-company editable afterwards.
   */
  async create(
    caller: AuthenticatedUser,
    dto: CreateCompanyDto,
    ipAddress: string,
  ): Promise<Company> {
    const shortCode = normalizeShortCode(dto.shortCode);
    const { defaultRates, defaultPayrollLockDay } =
      this.configService.get<SettingsConfig>('settings');

    const created = await withRlsContext(
      this.prisma,
      // Company creation is Super-Admin-gated at the guard layer (FR-001); the
      // seeded DocumentType/EmployeeCodeSequence rows below are RLS-protected and
      // belong to a company that does not exist yet, so this must run as system.
      { isSuperAdmin: true },
      async (tx) => {
        const clash = await tx.company.findFirst({
          where: { shortCode: { equals: shortCode, mode: 'insensitive' } },
          select: { id: true },
        });
        if (clash) {
          throw new ConflictException(
            `Short code ${shortCode} is already in use by another company`,
          );
        }

        const company = await tx.company.create({
          data: {
            name: dto.name.trim(),
            shortCode,
            logoUrl: dto.logoUrl ?? null,
            status: dto.status ?? 'active',
            gstin: dto.gstin ?? null,
            pan: dto.pan ?? null,
            cin: dto.cin ?? null,
            tan: dto.tan ?? null,
            address: dto.address ?? null,
            city: dto.city ?? null,
            state: dto.state ?? null,
            pinCode: dto.pinCode ?? null,
            pfEstablishmentCode: dto.pfEstablishmentCode ?? null,
            esicCode: dto.esicCode ?? null,
            professionalTaxRegNumber: dto.professionalTaxRegNumber ?? null,
            bocwRegNumber: dto.bocwRegNumber ?? null,
            payCycle: dto.payCycle ?? 'monthly',
            payrollLockDay: dto.payrollLockDay ?? defaultPayrollLockDay,
            pfEmployerRate: dto.pfEmployerRate ?? defaultRates.pfEmployer,
            esicEmployerRate: dto.esicEmployerRate ?? defaultRates.esicEmployer,
            gratuityRate: dto.gratuityRate ?? defaultRates.gratuity,
            bonusRate: dto.bonusRate ?? defaultRates.bonus,
            otMultiplier: dto.otMultiplier ?? defaultRates.otMultiplier,
          },
        });

        await this.documentTypes.seedDefaultsForCompany(company.id, tx);
        // Same treatment document types get: a new company starts with the six
        // common vendor categories rather than an empty master that blocks the
        // first vendor anyone tries to create (007 US1).
        await this.vendorCategories.seedDefaultsForCompany(company.id, tx);
        await tx.employeeCodeSequence.create({
          data: { companyId: company.id, lastNumber: 0 },
        });

        return company;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.COMPANY,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.id,
      ipAddress,
    });
    return created;
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateCompanyDto,
    ipAddress: string,
  ): Promise<Company> {
    const { before, updated } = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      async (tx) => {
        const existing = await tx.company.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Company ${id} not found`);
        }

        const shortCode = dto.shortCode
          ? normalizeShortCode(dto.shortCode)
          : undefined;
        if (shortCode && shortCode !== existing.shortCode) {
          const clash = await tx.company.findFirst({
            where: {
              id: { not: id },
              shortCode: { equals: shortCode, mode: 'insensitive' },
            },
            select: { id: true },
          });
          if (clash) {
            throw new ConflictException(
              `Short code ${shortCode} is already in use by another company`,
            );
          }
        }

        // Changing the short code re-prefixes future employee codes only; the
        // sequence counter is untouched and keeps running (FR-024).
        const row = await tx.company.update({
          where: { id },
          data: { ...dto, ...(shortCode ? { shortCode } : {}) },
        });
        return { before: existing, updated: row };
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.COMPANY,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: {
        before: this.auditable(before),
        after: this.auditable(updated),
      } as unknown as Prisma.InputJsonValue,
      accountId: caller.id,
      companyId: id,
      ipAddress,
    });
    return updated;
  }

  /** Decimal columns aren't JSON-serializable, so the audit snapshot carries their
   * numeric values rather than Prisma's Decimal objects. */
  private auditable(company: Company): Record<string, unknown> {
    return {
      ...company,
      pfEmployerRate: company.pfEmployerRate.toNumber(),
      esicEmployerRate: company.esicEmployerRate.toNumber(),
      gratuityRate: company.gratuityRate.toNumber(),
      bonusRate: company.bonusRate.toNumber(),
      otMultiplier: company.otMultiplier.toNumber(),
    };
  }
}
