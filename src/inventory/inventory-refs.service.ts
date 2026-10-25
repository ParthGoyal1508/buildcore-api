import { BadRequestException, Injectable } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor } from '../common/prisma/rls-context';
import { parseDateOnly } from '../hr/leave/leave-days';
import { PartnersService } from '../partners/partners.service';
import { ProjectsService } from '../projects/portfolio/projects.service';
import { SiteGeofence, SitesService } from '../projects/sites/sites.service';
import { CompaniesService } from '../settings/companies/companies.service';
import {
  CompositeItemView,
  CompositeItemsService,
} from '../settings/item-masters/composite-items.service';
import { ItemView, ItemsService } from '../settings/item-masters/items.service';
import { companyScope } from '../settings/company-scope';

/**
 * Cross-module reference resolution for the inventory module (FR-011, FR-012).
 *
 * Every id this module stores as a plain column — item, site, vendor — is validated
 * and named here, through the owning module's exported service. Principle I forbids
 * `inventory` querying `settings`, `projects` or `partners` directly, and gathering
 * the calls in one place is what keeps that from being re-litigated at each of the
 * five services that need it.
 */
@Injectable()
export class InventoryRefsService {
  constructor(
    private readonly items: ItemsService,
    private readonly sites: SitesService,
    private readonly partners: PartnersService,
    private readonly projects: ProjectsService,
    private readonly compositeItems: CompositeItemsService,
    private readonly companies: CompaniesService,
  ) {}

  /** A site's geofence, for a site entry's location check (043) — the punch's own source. */
  async siteGeofence(
    caller: AuthenticatedUser,
    siteId: string,
  ): Promise<SiteGeofence> {
    return this.sites.getGeofence(rlsContextFor(caller), siteId);
  }

  /** The company's GPS accuracy ceiling, the same one attendance punches are held to (043). */
  async punchAccuracyMaxMetres(companyId: string): Promise<number> {
    return this.companies.getPunchAccuracyMaxMetres(companyId);
  }

  /** Active items matching a name or code, for the site entry's item picker (043). */
  async searchActiveItems(
    caller: AuthenticatedUser,
    search: string | undefined,
  ): Promise<ItemView[]> {
    const page = await this.items.findAll(caller, {
      search: search?.trim() || undefined,
      active: true,
      pageSize: 50,
    });
    return page.items;
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

  async requireItem(
    caller: AuthenticatedUser,
    itemId: string,
    companyId: string,
  ): Promise<ItemView> {
    const item = await this.items.getItem(caller, itemId);
    if (!item || item.companyId !== companyId) {
      throw new BadRequestException(
        `Item ${itemId} does not exist in this company`,
      );
    }
    return item;
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

  /** The project a site belongs to, for denormalising onto an indent. Null is a
   * legitimate answer: a site need not belong to a project. */
  async projectOfSite(
    caller: AuthenticatedUser,
    siteId: string,
  ): Promise<string | null> {
    const site = await this.sites.getSiteById(rlsContextFor(caller), siteId);
    return site.projectId ?? null;
  }

  /** A project in the target company, for an issue naming what it was for (2026-10-15). */
  async requireProject(
    caller: AuthenticatedUser,
    projectId: string,
    companyId: string,
  ): Promise<{ id: string; code: string; name: string }> {
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

  /** "CODE · Name" for a list of project ids, tolerating a missing one. */
  async projectNames(
    caller: AuthenticatedUser,
    projectIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(projectIds)];
    const ctx = rlsContextFor(caller);
    const entries = await Promise.all(
      unique.map(async (projectId) => {
        const project = await this.projects
          .getProjectIdentityById(projectId, ctx)
          .catch(() => null);
        return [
          projectId,
          project ? `${project.code} · ${project.name}` : 'Unknown project',
        ] as const;
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

  /**
   * A vendor that may be *written against* in `companyId`: one of that company's, and active
   * (036 M6).
   *
   * `requireVendorName` only asks whether the caller can see the vendor, and a Super Admin can see
   * every company's — so a purchase in one company could name another's supplier, and a vendor
   * marked inactive (stopped trading, blacklisted) could still be bought from and paid. Kept
   * separate from `requireVendorName` because that one also names the vendor on *existing*
   * rows, where a vendor deactivated since must still resolve.
   */
  async requireActiveVendor(
    caller: AuthenticatedUser,
    vendorId: string,
    companyId: string,
  ): Promise<string> {
    const vendor = await this.partners.getVendorById(
      vendorId,
      rlsContextFor(caller),
    );
    if (!vendor || vendor.companyId !== companyId) {
      throw new BadRequestException(
        `Vendor ${vendorId} does not exist in this company`,
      );
    }
    if (!vendor.active) {
      throw new BadRequestException(
        `${vendor.name} is inactive. Reactivate the vendor before recording against them.`,
      );
    }
    return vendor.name;
  }

  /**
   * Site names for a list of ids, in one pass.
   *
   * A missing or out-of-scope site resolves to a placeholder rather than throwing:
   * a purchase from last year whose site was since deleted should render as a row
   * with an unknown store, not fail the whole page — the same rule
   * `PartnersService.getVendorById()` documents for a deleted vendor.
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
        return [siteId, site?.name ?? 'Unknown store'] as const;
      }),
    );
    return new Map(entries);
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

  /** Item views for a list of ids, in one query. */
  async itemsByIds(
    caller: AuthenticatedUser,
    itemIds: string[],
  ): Promise<Map<string, ItemView>> {
    return this.items.getItemsByIds(caller, itemIds);
  }

  /** One item, or null if it does not exist or is out of scope. */
  async findItem(
    caller: AuthenticatedUser,
    itemId: string,
  ): Promise<ItemView | null> {
    return this.items.getItem(caller, itemId);
  }

  /**
   * Item ids matching a name/code search or a category, for a stock query that
   * needs to filter balances by item attributes.
   *
   * Resolved through the item master rather than joined, because the items live in
   * `settings` and a join across that boundary is what Principle I forbids.
   */
  async itemIdsMatching(
    caller: AuthenticatedUser,
    filters: { search?: string; categoryId?: string; companyId?: string },
  ): Promise<string[]> {
    // Ids only and unpaginated (036 M5): this used to be `findAll` at `MAX_PAGE_SIZE`, which cut
    // the match list at 200 and so dropped items from a filtered stock list without saying so.
    return this.items.getItemIdsMatching(caller, {
      search: filters.search,
      categoryId: filters.categoryId,
      companyId: filters.companyId,
    });
  }

  /** A composite item (039) of the target company that may be issued: it exists and is active. */
  async requireActiveCompositeItem(
    caller: AuthenticatedUser,
    compositeItemId: string,
    companyId: string,
  ): Promise<CompositeItemView> {
    const composite = await this.compositeItems.getCompositeItem(
      caller,
      compositeItemId,
    );
    if (!composite || composite.companyId !== companyId) {
      throw new BadRequestException(
        `Composite item ${compositeItemId} does not exist in this company`,
      );
    }
    if (!composite.active) {
      throw new BadRequestException(
        `${composite.name} is inactive. Reactivate it in the item master before issuing it.`,
      );
    }
    return composite;
  }

  /** Active composites for the issue form's picker, by name (039). */
  async searchCompositeItems(
    caller: AuthenticatedUser,
    query: { search?: string; companyId?: string },
  ): Promise<CompositeItemView[]> {
    const page = await this.compositeItems.findAll(caller, {
      search: query.search,
      companyId: query.companyId,
      active: true,
      pageSize: 50,
    });
    return page.compositeItems;
  }

  /** Composite names and units for a list of ids, in one query (039). */
  async compositeNames(
    caller: AuthenticatedUser,
    ids: string[],
  ): Promise<Map<string, { name: string; unit: string }>> {
    return this.compositeItems.getNamesByIds(caller, ids);
  }
}
