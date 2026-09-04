import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthenticatedUser } from '../auth/authenticated-user';
import type {
  SettingsConfig,
  WorkspaceConfig,
  HrPayrollConfig,
} from '../common/configs/config.interface';
import { rlsContextFor } from '../common/prisma/rls-context';
import { CompaniesService } from '../settings/companies/companies.service';
import { SkillCategoriesService } from '../settings/skill-categories/skill-categories.service';
import { SitesService, SiteGeofence } from '../projects/sites/sites.service';
import { PartnersService } from '../partners/partners.service';

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
  ): Promise<void> {
    const vendor = await this.partners.getVendorById(
      contractorId,
      rlsContextFor(caller),
    );
    if (!vendor) {
      throw new BadRequestException('Contractor not found');
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

  async getLabourSettings(companyId: string) {
    return this.companies.getLabourSettings(companyId);
  }
}
