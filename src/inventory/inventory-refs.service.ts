import { BadRequestException, Injectable } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor } from '../common/prisma/rls-context';
import { parseDateOnly } from '../hr/leave/leave-days';
import { MAX_PAGE_SIZE } from './constants/inventory.constants';
import { PartnersService } from '../partners/partners.service';
import { SitesService } from '../projects/sites/sites.service';
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
    const matches = await this.items.findAll(caller, {
      search: filters.search,
      categoryId: filters.categoryId,
      companyId: filters.companyId,
      pageSize: MAX_PAGE_SIZE,
    });
    return matches.items.map((item) => item.id);
  }
}
