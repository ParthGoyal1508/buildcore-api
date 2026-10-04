import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, AuditEntityType, Company, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';
import { AuditLogService } from '../../auth/audit-log.service';
import { DEFAULT_SLOT_ROLE_NAMES } from '../../approvals/approval-slots';
import { ChainsService } from '../../approvals/chains.service';
import { EquipmentCategoriesService } from '../machinery-masters/equipment-categories.service';
import { EquipmentDocTypesService } from '../machinery-masters/equipment-doc-types.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import type {
  SettingsConfig,
  WorkspaceConfig,
} from '../../common/configs/config.interface';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { AssetCategoriesService } from '../asset-masters/asset-categories.service';
import { AssetDocTypesService } from '../asset-masters/asset-doc-types.service';
import { ConditionGradesService } from '../asset-masters/condition-grades.service';
import { DocumentTypesService } from '../reference-data/document-types.service';
import { ItemCategoriesService } from '../item-masters/item-categories.service';
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
    private readonly itemCategories: ItemCategoriesService,
    private readonly assetCategories: AssetCategoriesService,
    private readonly assetDocTypes: AssetDocTypesService,
    private readonly conditionGrades: ConditionGradesService,
    private readonly equipmentCategories: EquipmentCategoriesService,
    private readonly equipmentDocTypes: EquipmentDocTypesService,
    private readonly approvalChains: ChainsService,
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
   * The worst GPS accuracy a punch may report and still be located, in metres (020 FR-012b).
   *
   * Resolves the company's own value against the configured default, so **no caller knows the
   * fallback exists**. That matters more than it sounds: a caller that had to handle null would end
   * up with the default written into it, and then there would be two places the number lives.
   *
   * Exported for `hr` for the same reason `getPayrollLockDay` is — Principle I forbids that module
   * reading `settings.Company`.
   */
  async getPunchAccuracyMaxMetres(companyId: string): Promise<number> {
    const company = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.company.findUnique({
          where: { id: companyId },
          select: { punchAccuracyMaxMetres: true },
        }),
    );
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    // Null means "has not decided", which is why the column is nullable — so it follows the product
    // default rather than freezing whatever the default was on the day the row was created.
    return (
      company.punchAccuracyMaxMetres ??
      this.configService.get<WorkspaceConfig>('workspace')
        .punchAccuracyMaxMetresDefault
    );
  }

  /**
   * Sets it (020 FR-012b, T008).
   *
   * `null` clears the company's decision and returns it to the product default, which is a
   * different act from setting it to 50 — see the column's comment.
   */
  async setPunchAccuracyMaxMetres(
    companyId: string,
    metres: number | null,
  ): Promise<{ punchAccuracyMaxMetres: number | null; effective: number }> {
    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.company.update({
        where: { id: companyId },
        data: { punchAccuracyMaxMetres: metres },
      }),
    );
    return {
      punchAccuracyMaxMetres: metres,
      effective: await this.getPunchAccuracyMaxMetres(companyId),
    };
  }

  /**
   * The ceiling on total deductions from one payslip, as a percentage of gross wages (020 FR-007a).
   *
   * Exported for `payroll` on the same terms as the other getters here — Principle I forbids that
   * module reading `settings.Company`. The database bounds it at 50, so a caller never has to defend
   * against a value that would be unlawful.
   */
  async getDeductionCeilingPercent(companyId: string): Promise<number> {
    const company = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.company.findUnique({
          where: { id: companyId },
          select: { deductionCeilingPercent: true },
        }),
    );
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company.deductionCeilingPercent;
  }

  /**
   * Whether this company refuses a punch that fails validation, rather than flagging it (020 FR-013).
   *
   * Read per request alongside the accuracy threshold, so switching it takes effect on the next
   * punch with no restart. That is not a convenience here: the whole reason this is a company
   * setting rather than a deploy is that the client's answer should be reversible within minutes of
   * seeing what it does.
   *
   * Exported for `hr` on the same terms as `getPayrollLockDay` — Principle I forbids that module
   * reading `settings.Company` itself.
   */
  async isPunchBlockEnforced(companyId: string): Promise<boolean> {
    const company = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.company.findUnique({
          where: { id: companyId },
          select: { punchBlockEnforced: true },
        }),
    );
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company.punchBlockEnforced;
  }

  /**
   * Switches the hard refusal on or off for one company (020 FR-013).
   *
   * Boolean and not nullable, unlike `punchAccuracyMaxMetres` next to it. There is no third state
   * worth modelling: "this company has not decided" and "this company does not refuse punches" lead
   * to identical behaviour, and a nullable flag would invite a product default that silently started
   * refusing punches for every company that had never been asked.
   */
  async setPunchBlockEnforced(
    companyId: string,
    enforced: boolean,
  ): Promise<{ punchBlockEnforced: boolean }> {
    await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
      tx.company.update({
        where: { id: companyId },
        data: { punchBlockEnforced: enforced },
      }),
    );
    return { punchBlockEnforced: enforced };
  }

  /**
   * The companies the caller can see — their own one, or every active company for a
   * Super Admin (004 US6). Backs the Group Dashboard's per-company cards and Group
   * Total. Scope is enforced by RLS: an ordinary caller's context filters to their
   * own `companyId`, a `CROSS_COMPANY_ACCESS` caller's spans all. Returns id, name
   * and shortCode only — the card needs no more.
   */
  async listAccessible(
    caller: AuthenticatedUser,
  ): Promise<{ id: string; name: string; shortCode: string }[]> {
    return withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.company.findMany({
        where: { status: 'active' },
        select: { id: true, name: true, shortCode: true },
        orderBy: { name: 'asc' },
      }),
    );
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

  /**
   * The labour-settlement configuration feature 013 reads (013 FR-041, FR-027,
   * FR-049).
   *
   * Exported for `labour` for the same Principle I reason the payroll rates are
   * exported for `payroll`: the labour module may not query `settings.Company`
   * itself. The OT multiplier is deliberately the same column 005 defined — 013
   * reads it, never adds a second (FR-049). Denominations come back descending so
   * the greedy breakup can iterate them directly; numbers, not Decimals, keep the
   * consuming computation free of Prisma types.
   */
  async getLabourSettings(companyId: string): Promise<{
    wageCycle: 'weekly' | 'fortnightly' | 'monthly';
    cashDenominations: number[];
    otMultiplier: number;
  }> {
    const company = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.company.findUnique({
          where: { id: companyId },
          select: {
            labourWageCycle: true,
            labourCashDenominations: true,
            otMultiplier: true,
          },
        }),
    );
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return {
      wageCycle: company.labourWageCycle,
      cashDenominations: [...company.labourCashDenominations].sort(
        (a, b) => b - a,
      ),
      otMultiplier: company.otMultiplier.toNumber(),
    };
  }

  /** Every company, whatever its status — the Settings UI's own admin list. Not the
   * source other modules' dropdowns read (see `listActiveForOtherModules`). */
  async findAll(): Promise<Company[]> {
    return this.prisma.company.findMany({ orderBy: { name: 'asc' } });
  }

  /** A company's display name, for feature 011's letter token substitution. */
  async getName(companyId: string): Promise<string> {
    const company = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.company.findUnique({
          where: { id: companyId },
          select: { name: true },
        }),
    );
    if (!company) throw new NotFoundException('Company not found');
    return company.name;
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
        // And the ten material categories, for the same reason: an empty item
        // master blocks the first purchase anyone tries to record (009 FR-016,
        // research.md §15).
        await this.itemCategories.seedDefaultsForCompany(company.id, tx);
        // And the three asset masters (012 US1). The condition grades matter most
        // of the three: a return maps its grade to the asset's next status
        // (FR-015), so an empty ladder does not merely inconvenience the register —
        // it makes returning an asset impossible.
        await this.assetCategories.seedDefaultsForCompany(company.id, tx);
        await this.assetDocTypes.seedDefaultsForCompany(company.id, tx);
        await this.conditionGrades.seedDefaultsForCompany(company.id, tx);
        // And the two machinery masters (006 T058, added 2026-10-04). They were the only two
        // `seedDefaultsForCompany` methods in `settings` that nothing called outside the demo
        // seed, so every company was created with no equipment categories and no equipment
        // document types — measured at zero rows for both live companies, which means **the first
        // person to register a machine was refused** until they hand-created a category.
        //
        // **Correction, same day:** an earlier version of this comment said the ten defaults carry
        // the fuel benchmarks the variance alerts are computed from. They do not —
        // `DEFAULT_EQUIPMENT_CATEGORIES` carries a name and a meter type and nothing else, and the
        // benchmark is null on every row this seeds. Checked after writing the claim, not before.
        // The benchmark is still a per-category setting somebody has to fill in; see 006 T061.
        await this.equipmentCategories.seedDefaultsForCompany(company.id, tx);
        await this.equipmentDocTypes.seedDefaultsForCompany(company.id, tx);
        // Feature 016's approval chains — the shape and, since 2026-10-04, the staffing.
        // Both are resolved HERE, in the module that owns `settings.Role`, and handed
        // over: the approval spine lives in `shared` and reading roles itself would be
        // the cross-schema query Principle I forbids.
        //
        // Only `final` used to be mapped, on the argument that the other two slots were
        // not guessable. The client answered on 2026-10-04 and they are no longer guesses
        // — and the gap had a cost: five of the twelve chains seeded below name those
        // slots, so a company could not approve a payroll run until somebody made two
        // settings entries. Neither of the two live companies had.
        const superAdminRole = await tx.role.findFirst({
          where: { isProtected: true },
          select: { id: true },
        });
        // Resolved by name, and a name that no longer exists resolves to nothing rather
        // than failing the creation — a renamed default role must not make a company
        // uncreatable. The unmapped slot is then reported by `APPROVAL_SLOT_UNMAPPED`,
        // which is the behaviour this used to rely on for all three.
        const slotRoles = await tx.role.findMany({
          where: { name: { in: Object.values(DEFAULT_SLOT_ROLE_NAMES) } },
          select: { id: true, name: true },
        });
        const idByName = new Map(slotRoles.map((r) => [r.name, r.id]));
        const slotRoleIds = Object.fromEntries(
          Object.entries(DEFAULT_SLOT_ROLE_NAMES).map(([slotKey, roleName]) => [
            slotKey,
            idByName.get(roleName) ?? null,
          ]),
        );
        await this.approvalChains.seedDefaultsForCompany(company.id, tx, {
          superAdminRoleId: superAdminRole?.id ?? null,
          slotRoleIds,
        });

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
