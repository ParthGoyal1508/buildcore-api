import { BadRequestException, Injectable } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor } from '../common/prisma/rls-context';
import { parseDateOnly } from '../hr/leave/leave-days';
import { EmployeesService } from '../hr/employees/employees.service';
import { PartnersService } from '../partners/partners.service';
import { SitesService } from '../projects/sites/sites.service';
import {
  EquipmentCategoriesService,
  EquipmentCategoryView,
} from '../settings/machinery-masters/equipment-categories.service';
import {
  EquipmentDocTypeView,
  EquipmentDocTypesService,
} from '../settings/machinery-masters/equipment-doc-types.service';
import { companyScope } from '../settings/company-scope';

/**
 * Cross-module reference resolution for the plant module (FR-009).
 *
 * Every id this module stores as a plain column — category, doc type, site, vendor,
 * operator — is validated and named here, through the owning module's exported
 * service. Principle I forbids `plant` querying `settings`, `projects`, `partners`
 * or `hr` directly, and gathering the calls in one place is what keeps that from
 * being re-litigated at each of the eight services that need it. Directly modelled
 * on `InventoryRefsService`, which does the same job for 009.
 */
@Injectable()
export class PlantRefsService {
  constructor(
    private readonly categories: EquipmentCategoriesService,
    private readonly docTypes: EquipmentDocTypesService,
    private readonly sites: SitesService,
    private readonly partners: PartnersService,
    private readonly employees: EmployeesService,
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

  async requireCategory(
    caller: AuthenticatedUser,
    categoryId: string,
    companyId: string,
  ): Promise<EquipmentCategoryView> {
    const category = await this.categories.getCategory(caller, categoryId);
    if (!category || category.companyId !== companyId) {
      throw new BadRequestException(
        `Equipment category ${categoryId} does not exist in this company`,
      );
    }
    return category;
  }

  async categoriesByIds(
    caller: AuthenticatedUser,
    categoryIds: string[],
  ): Promise<Map<string, EquipmentCategoryView>> {
    return this.categories.getCategoriesByIds(caller, categoryIds);
  }

  async requireDocType(
    caller: AuthenticatedUser,
    docTypeId: string,
    companyId: string,
  ): Promise<EquipmentDocTypeView> {
    const docType = await this.docTypes.getDocType(caller, docTypeId);
    if (!docType || docType.companyId !== companyId) {
      throw new BadRequestException(
        `Document type ${docTypeId} does not exist in this company`,
      );
    }
    return docType;
  }

  async docTypesByIds(
    caller: AuthenticatedUser,
    docTypeIds: string[],
  ): Promise<Map<string, EquipmentDocTypeView>> {
    return this.docTypes.getDocTypesByIds(caller, docTypeIds);
  }

  async requireSiteName(
    caller: AuthenticatedUser,
    siteId: string,
    companyId: string,
  ): Promise<string> {
    const site = await this.sites.getSiteById(rlsContextFor(caller), siteId);
    if (site.companyId !== companyId) {
      throw new BadRequestException(
        `Site ${siteId} does not exist in this company`,
      );
    }
    return site.name;
  }

  /**
   * Site names for a list of ids, in one pass.
   *
   * A missing or out-of-scope site resolves to a placeholder rather than throwing:
   * a machine whose site was since deleted should render as a row with an unknown
   * deployment, not fail the whole register — the same rule `InventoryRefsService`
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

  /** Vendor names for a list of ids, with the same missing-vendor tolerance. */
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

  /**
   * A vendor's TDS section and rate, for hire and service bill computation (FR-005,
   * FR-021).
   *
   * Never client-supplied: the deduction is a statutory figure held against the
   * vendor, and letting a bill carry its own would make every bill's net payable a
   * matter of what the person raising it typed.
   */
  async vendorTds(
    caller: AuthenticatedUser,
    vendorId: string,
  ): Promise<{ tdsSection: string | null; tdsRate: number | null }> {
    return this.partners.getVendorTds(vendorId, rlsContextFor(caller));
  }

  /** Operator names for a list of employee ids, with the same missing-row
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
        return [employeeId, employee?.name ?? 'Unknown operator'] as const;
      }),
    );
    return new Map(entries);
  }

  /** Validates an operator id against HR before it is stored as a plain column. */
  async requireEmployee(
    caller: AuthenticatedUser,
    employeeId: string,
    companyId: string,
  ): Promise<void> {
    const employee = await this.employees.getById(
      rlsContextFor(caller),
      employeeId,
    );
    if (!employee || employee.companyId !== companyId) {
      throw new BadRequestException(
        `Employee ${employeeId} does not exist in this company`,
      );
    }
  }
}
