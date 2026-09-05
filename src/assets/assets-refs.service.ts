import { BadRequestException, Injectable } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor } from '../common/prisma/rls-context';
import { EmployeesService } from '../hr/employees/employees.service';
import { parseDateOnly } from '../hr/leave/leave-days';
import { InventoryService } from '../inventory/inventory.service';
import { PartnersService } from '../partners/partners.service';
import { SitesService } from '../projects/sites/sites.service';
import {
  AssetCategoriesService,
  AssetCategoryView,
} from '../settings/asset-masters/asset-categories.service';
import {
  AssetDocTypeView,
  AssetDocTypesService,
} from '../settings/asset-masters/asset-doc-types.service';
import {
  ConditionGradeView,
  ConditionGradesService,
} from '../settings/asset-masters/condition-grades.service';
import { companyScope } from '../settings/company-scope';

/** What the custody rule needs to know about an employee: that they exist, and
 * where they are posted (spec FR-010). */
export interface CustodianRef {
  id: string;
  name: string;
  siteId: string;
}

/**
 * Cross-module reference resolution for the assets module (spec FR-036).
 *
 * Every id this schema stores as a plain column — category, doc type, condition
 * grade, site, project, vendor, custodian, purchase — is validated and named here,
 * through the owning module's exported service. Principle I forbids `assets`
 * querying `settings`, `projects`, `partners`, `hr` or `inventory` directly, and
 * gathering the calls in one place is what keeps that from being re-litigated at
 * each of the services that need it. Directly modelled on `PlantRefsService`, which
 * does the same job for 006.
 */
@Injectable()
export class AssetsRefsService {
  constructor(
    private readonly categories: AssetCategoriesService,
    private readonly docTypes: AssetDocTypesService,
    private readonly grades: ConditionGradesService,
    private readonly sites: SitesService,
    private readonly partners: PartnersService,
    private readonly employees: EmployeesService,
    private readonly inventory: InventoryService,
  ) {}

  /**
   * The company a write belongs to: the caller's own, or the one a cross-company
   * caller named. Same order and same 400 every other module uses.
   */
  targetCompanyOf(caller: AuthenticatedUser, requested?: string): string {
    const scope = companyScope(caller, requested);
    const companyId = scope.companyId ?? caller.companyId;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  /** A `YYYY-MM-DD` (or full ISO) request field as the date-only value a `@db.Date`
   * column stores. */
  parseDate(value: string): Date {
    return parseDateOnly(value.slice(0, 10));
  }

  // ── settings masters ──────────────────────────────────────────────────────

  async requireCategory(
    caller: AuthenticatedUser,
    categoryId: string,
    companyId: string,
  ): Promise<AssetCategoryView> {
    const category = await this.categories.getCategory(caller, categoryId);
    if (!category || category.companyId !== companyId) {
      throw new BadRequestException(
        `Asset category ${categoryId} does not exist in this company`,
      );
    }
    return category;
  }

  async categoriesByIds(
    caller: AuthenticatedUser,
    categoryIds: string[],
  ): Promise<Map<string, AssetCategoryView>> {
    return this.categories.getCategoriesByIds(caller, categoryIds);
  }

  async requireDocType(
    caller: AuthenticatedUser,
    docTypeId: string,
    companyId: string,
  ): Promise<AssetDocTypeView> {
    const docType = await this.docTypes.getDocType(caller, docTypeId);
    if (!docType || docType.companyId !== companyId) {
      throw new BadRequestException(
        `Asset document type ${docTypeId} does not exist in this company`,
      );
    }
    return docType;
  }

  async docTypesByIds(
    caller: AuthenticatedUser,
    docTypeIds: string[],
  ): Promise<Map<string, AssetDocTypeView>> {
    return this.docTypes.getDocTypesByIds(caller, docTypeIds);
  }

  /** A condition grade, with the `isDamaged` / `isScrap` flags the return mapping
   * of FR-015 turns into a status. */
  async requireGrade(
    caller: AuthenticatedUser,
    gradeId: string,
    companyId: string,
  ): Promise<ConditionGradeView> {
    const grade = await this.grades.getGrade(caller, gradeId);
    if (!grade || grade.companyId !== companyId) {
      throw new BadRequestException(
        `Condition grade ${gradeId} does not exist in this company`,
      );
    }
    return grade;
  }

  async gradesByIds(
    caller: AuthenticatedUser,
    gradeIds: string[],
  ): Promise<Map<string, ConditionGradeView>> {
    return this.grades.getGradesByIds(caller, gradeIds);
  }

  // ── projects ──────────────────────────────────────────────────────────────

  /**
   * A site, validated against the company — and, when a project is named, against
   * that project too.
   *
   * The pair is checked in one lookup rather than validating the project
   * separately: `Site.projectId` is the authoritative link, so a site that is not
   * the project's is the only way the pair can be wrong, and a second query would
   * only tell us the project exists.
   */
  async requireSite(
    caller: AuthenticatedUser,
    siteId: string,
    companyId: string,
    projectId?: string,
  ): Promise<{ id: string; name: string; projectId: string | null }> {
    const site = await this.sites
      .getSiteById(rlsContextFor(caller), siteId)
      .catch(() => null);
    if (!site || site.companyId !== companyId) {
      throw new BadRequestException(
        `Site ${siteId} does not exist in this company`,
      );
    }
    if (projectId && site.projectId !== projectId) {
      throw new BadRequestException(
        `Site ${site.name} does not belong to project ${projectId}`,
      );
    }
    return { id: site.id, name: site.name, projectId: site.projectId };
  }

  /**
   * Site names for a list of ids, in one pass.
   *
   * A missing or out-of-scope site resolves to a placeholder rather than throwing:
   * an asset whose site was since deleted should render as a row with an unknown
   * location, not fail the whole register — the same rule `PlantRefsService`
   * documents.
   */
  async siteNames(
    caller: AuthenticatedUser,
    siteIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(siteIds)];
    const ctx = rlsContextFor(caller);
    const entries = await Promise.all(
      unique.map(async (siteId) => {
        const site = await this.sites
          .getSiteById(ctx, siteId)
          .catch(() => null);
        return [siteId, site?.name ?? 'Unknown site'] as const;
      }),
    );
    return new Map(entries);
  }

  // ── partners ──────────────────────────────────────────────────────────────

  async requireVendorName(
    caller: AuthenticatedUser,
    vendorId: string,
  ): Promise<string> {
    const vendor = await this.partners.getVendorById(
      vendorId,
      rlsContextFor(caller),
    );
    if (!vendor) {
      throw new BadRequestException(`Vendor ${vendorId} not found`);
    }
    return vendor.name;
  }

  /** Vendor names for a list of ids, with the same missing-vendor tolerance — a
   * repair outlives the vendor that performed it (spec Edge Cases). */
  async vendorNames(
    caller: AuthenticatedUser,
    vendorIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(vendorIds)];
    const ctx = rlsContextFor(caller);
    const entries = await Promise.all(
      unique.map(async (vendorId) => {
        const vendor = await this.partners
          .getVendorById(vendorId, ctx)
          .catch(() => null);
        return [vendorId, vendor?.name ?? 'Unknown vendor'] as const;
      }),
    );
    return new Map(entries);
  }

  // ── hr ────────────────────────────────────────────────────────────────────

  /**
   * A custodian, with the site they are posted at.
   *
   * The posting is returned rather than checked here because the rule differs by
   * caller: an allocation requires the custodian to be at the allocation's site
   * (FR-010), while a register listing only wants the name.
   */
  async requireCustodian(
    caller: AuthenticatedUser,
    employeeId: string,
    companyId: string,
  ): Promise<CustodianRef> {
    const employee = await this.employees
      .getById(rlsContextFor(caller), employeeId)
      .catch(() => null);
    if (!employee || employee.companyId !== companyId) {
      throw new BadRequestException(
        `Employee ${employeeId} does not exist in this company`,
      );
    }
    return { id: employee.id, name: employee.name, siteId: employee.siteId };
  }

  /** Custodian names for a list of employee ids, with the same missing-row
   * tolerance the site and vendor lookups have. */
  async employeeNames(
    caller: AuthenticatedUser,
    employeeIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(employeeIds)];
    const ctx = rlsContextFor(caller);
    const entries = await Promise.all(
      unique.map(async (employeeId) => {
        const employee = await this.employees
          .getById(ctx, employeeId)
          .catch(() => null);
        return [employeeId, employee?.name ?? 'Unknown employee'] as const;
      }),
    );
    return new Map(entries);
  }

  // ── inventory ─────────────────────────────────────────────────────────────

  /**
   * The purchase an asset was acquired through (spec FR-038).
   *
   * Optional on the asset, so this is only called when one was supplied — but when
   * it is, a bad id is a 400 rather than a silently stored dangling reference.
   */
  async requirePurchase(
    caller: AuthenticatedUser,
    purchaseId: string,
    companyId: string,
  ): Promise<{ id: string; date: Date; amount: number; vendorId: string }> {
    const purchase = await this.inventory.getPurchaseById(
      purchaseId,
      rlsContextFor(caller),
    );
    if (!purchase || purchase.companyId !== companyId) {
      throw new BadRequestException(
        `Purchase ${purchaseId} does not exist in this company`,
      );
    }
    return {
      id: purchase.id,
      date: purchase.date,
      amount: purchase.amount,
      vendorId: purchase.vendorId,
    };
  }
}
