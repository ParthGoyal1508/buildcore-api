import { BadRequestException, Injectable } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor } from '../common/prisma/rls-context';
import { parseDateOnly } from '../hr/leave/leave-days';
import { EmployeesService } from '../hr/employees/employees.service';
import {
  PartnersService,
  VendorParticulars,
} from '../partners/partners.service';
import { CompaniesService } from '../settings/companies/companies.service';
import type { FormCompany } from '../common/form-document';
import { ProjectsService } from '../projects/portfolio/projects.service';
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
    private readonly companies: CompaniesService,
    private readonly projects: ProjectsService,
  ) {}

  /** A project of this company, for a hire order or a job card heading (2026-10-15). */
  async requireProject(
    caller: AuthenticatedUser,
    projectId: string,
    companyId: string,
  ): Promise<{
    id: string;
    code: string;
    name: string;
    location: string | null;
  }> {
    const project = await this.projects.getProjectIdentityById(
      projectId,
      rlsContextFor(caller),
    );
    if (!project || project.companyId !== companyId) {
      throw new BadRequestException(
        `Project ${projectId} does not exist in this company`,
      );
    }
    return project;
  }

  /** The project a site belongs to, if any — where a deployed machine is working. */
  async projectOfSite(
    caller: AuthenticatedUser,
    siteId: string,
  ): Promise<{
    id: string;
    code: string;
    name: string;
    location: string | null;
  } | null> {
    const site = await this.sites
      .getSiteById(rlsContextFor(caller), siteId)
      .catch(() => null);
    if (!site?.projectId) return null;
    return this.projects.getProjectIdentityById(
      site.projectId,
      rlsContextFor(caller),
    );
  }

  /** The company as a printed plant document heads it: name, address, logo (2026-10-15). */
  async documentCompany(
    companyId: string,
  ): Promise<FormCompany & { place: string | null }> {
    const identity = await this.companies.getDocumentIdentity(companyId);
    return {
      name: identity.name,
      address: identity.address,
      logo: identity.logo,
      place: identity.place,
    };
  }

  /** A vendor's address, PAN, contact and bank, for the hire order and the hiring bill. */
  async vendorParticulars(
    caller: AuthenticatedUser,
    vendorId: string,
  ): Promise<VendorParticulars | null> {
    return this.partners.getVendorParticulars(vendorId, rlsContextFor(caller));
  }

  /** The company's sites, for matching a location written on an imported sheet. */
  async companySites(
    caller: AuthenticatedUser,
    companyId: string,
  ): Promise<{ id: string; name: string }[]> {
    return this.sites.listForCompany(rlsContextFor(caller), companyId);
  }

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
