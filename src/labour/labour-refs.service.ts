import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../auth/authenticated-user';
import type {
  SettingsConfig,
  WorkspaceConfig,
  HrPayrollConfig,
} from '../common/configs/config.interface';
import { rlsContextFor, withRlsContext } from '../common/prisma/rls-context';
import { CompaniesService } from '../settings/companies/companies.service';
import { SkillCategoriesService } from '../settings/skill-categories/skill-categories.service';
import { SitesService, SiteGeofence } from '../projects/sites/sites.service';
import { PartnersService } from '../partners/partners.service';
import type { LabourDayRules } from './attendance/labour-day.util';

/**
 * The labour module's single seam onto every other module (Principle I, FR-034).
 *
 * Site geofences come from `projects`, contractor validation from `partners`,
 * skill-category resolution and labour settings from `settings`, and the field-policy
 * tunables from config. Nothing in `labour` reads another schema directly — it all
 * funnels through here, the same way `InventoryRefsService` centralises 009's reads.
 */
@Injectable()
export class LabourRefsService {
  constructor(
    private readonly sites: SitesService,
    private readonly partners: PartnersService,
    private readonly companies: CompaniesService,
    private readonly skillCategories: SkillCategoriesService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** The IANA zone every labour calendar day is reckoned against (003 FR-018a). */
  get timeZone(): string {
    return this.configService.get<SettingsConfig>('settings').timezone;
  }

  get faceMatchThreshold(): number {
    return this.configService.get<WorkspaceConfig>('workspace').faceMatch
      .distanceThreshold;
  }

  get gpsAccuracyMaxMetres(): number {
    return this.configService.get<WorkspaceConfig>('workspace').labour
      .gpsAccuracyMaxMetres;
  }

  get advanceLimitMultiple(): number {
    return this.configService.get<WorkspaceConfig>('workspace').labour
      .advanceLimitMultiple;
  }

  get backdatingMaxAgeHours(): number {
    return this.configService.get<WorkspaceConfig>('workspace').offlineQueue
      .maxAgeHours;
  }

  get clockSkewToleranceMinutes(): number {
    return this.configService.get<WorkspaceConfig>('workspace').offlineQueue
      .clockSkewToleranceMinutes;
  }

  get standardHoursPerDay(): number {
    return this.configService.get<HrPayrollConfig>('hrPayroll')
      .standardHoursPerDay;
  }

  /** The site's geofence, resolved via `projects` (FR-034). */
  async getSiteGeofence(
    caller: AuthenticatedUser,
    siteId: string,
  ): Promise<SiteGeofence> {
    return this.sites.getGeofence(rlsContextFor(caller), siteId);
  }

  /** The company a site belongs to (034). */
  async getSiteCompanyId(
    caller: AuthenticatedUser,
    siteId: string,
  ): Promise<string> {
    const site = await this.sites.getSiteById(rlsContextFor(caller), siteId);
    return site.companyId;
  }

  /** The project a site belongs to (or null), resolved via `projects` — used to
   * price a muster line against the project's wage rate. */
  async getSiteProjectId(
    caller: AuthenticatedUser,
    siteId: string,
  ): Promise<string | null> {
    const site = await this.sites.getSiteById(rlsContextFor(caller), siteId);
    return site.projectId ?? null;
  }

  /**
   * Validates that a contractor reference resolves to an active partner (FR-008,
   * FR-034). Raises 400 rather than returning a flag: it is only ever called while
   * creating a worker, where an unresolved contractor is a bad request.
   */
  async assertActiveContractor(
    caller: AuthenticatedUser,
    contractorId: string,
    companyId: string,
  ): Promise<void> {
    const vendor = await this.partners.getVendorById(
      contractorId,
      rlsContextFor(caller),
    );
    if (!vendor) {
      throw new BadRequestException('Contractor not found');
    }
    // 036 3e (2026-10-17): RLS alone stops a company-scoped caller, but a cross-company caller
    // with nothing selected reads every company's vendors — and could name another company's
    // contractor on this company's worker. The worker's company is compared explicitly.
    if (vendor.companyId !== companyId) {
      throw new BadRequestException(
        "This contractor belongs to another company. Pick one of this company's contractors.",
      );
    }
    if (!vendor.active) {
      throw new BadRequestException('Contractor is not active');
    }
  }

  /** Resolves a skill category, raising 400 for an unknown reference. */
  async requireSkillCategory(caller: AuthenticatedUser, id: string) {
    const category = await this.skillCategories.getById(caller, id);
    if (!category) {
      throw new BadRequestException('Skill category not found');
    }
    return category;
  }

  /** The company's GPS accuracy limit for a punch — the same one employee punches use (031). */
  async getPunchAccuracyMaxMetres(companyId: string): Promise<number> {
    return this.companies.getPunchAccuracyMaxMetres(companyId);
  }

  /** Whether a location failure refuses a punch or only flags it — the employee rule (031). */
  async isPunchBlockEnforced(companyId: string): Promise<boolean> {
    return this.companies.isPunchBlockEnforced(companyId);
  }

  async getLabourSettings(companyId: string) {
    return this.companies.getLabourSettings(companyId);
  }

  /** 034: the company's thresholds for counting a labour day from its punch times. */
  async getDayRules(companyId: string): Promise<LabourDayRules> {
    const { fullDayHours, halfDayHours, standardHours } =
      await this.companies.getLabourSettings(companyId);
    return { fullDayHours, halfDayHours, standardHours };
  }

  async setDayRules(companyId: string, rules: LabourDayRules): Promise<void> {
    await this.companies.setLabourDayRules(companyId, rules);
  }

  /** People's display names by user id — who recorded or corrected a punch (034). */
  async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const users = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.user.findMany({
          where: { id: { in: unique } },
          select: {
            id: true,
            displayName: true,
            firstname: true,
            lastname: true,
            username: true,
          },
        }),
    );
    return new Map(
      users.map((u) => [
        u.id,
        u.displayName?.trim() ||
          [u.firstname, u.lastname].filter(Boolean).join(' ').trim() ||
          u.username,
      ]),
    );
  }

  /**
   * Site names by id, via `projects` (036 O8). Unknown or out-of-scope ids are left out rather
   * than failing the read that wanted a label.
   */
  async siteNames(
    caller: AuthenticatedUser,
    ids: (string | null)[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const sites = await Promise.all(
      unique.map((id) =>
        this.sites.getSiteById(rlsContextFor(caller), id).catch(() => null),
      ),
    );
    return new Map(sites.filter((s) => s !== null).map((s) => [s.id, s.name]));
  }

  /** Skill category names by id, via `settings` (036 O8). */
  async skillCategoryNames(
    caller: AuthenticatedUser,
    ids: (string | null)[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const categories = await Promise.all(
      unique.map((id) => this.skillCategories.getById(caller, id)),
    );
    return new Map(
      categories.filter((c) => c !== null).map((c) => [c.id, c.name]),
    );
  }

  /** Contractor names by vendor id, via `partners` (034). */
  async contractorNames(
    caller: AuthenticatedUser,
    ids: (string | null)[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const vendors = await Promise.all(
      unique.map((id) =>
        this.partners.getVendorById(id, rlsContextFor(caller)),
      ),
    );
    return new Map(
      vendors.filter((v) => v !== null).map((v) => [v.id, v.name]),
    );
  }
}
