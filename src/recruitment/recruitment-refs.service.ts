import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import { AuthenticatedUser } from '../auth/authenticated-user';
import type { RecruitmentConfig } from '../common/configs/config.interface';
import { rlsContextFor } from '../common/prisma/rls-context';
import { CompaniesService } from '../settings/companies/companies.service';
import { effectiveCompanyId } from '../settings/company-scope';
import { DocumentTypesService } from '../settings/reference-data/document-types.service';
import { ReferenceDataService } from '../settings/reference-data/reference-data.service';
import { KitItemsService } from '../settings/kit-items/kit-items.service';
import { EmployeesService } from '../hr/employees/employees.service';
import { EmployeeDocumentsService } from '../hr/employees/documents/employee-documents.service';
import { ExitService } from '../hr/offboarding/exit.service';
import type { Caller } from '../hr/biometrics/face-enrolment.service';
import type { CreateEmployeeDto } from '../hr/employees/dto/create-employee.dto';
import type { UploadEmployeeDocumentDto } from '../hr/employees/documents/dto/upload-document.dto';
import { ProjectsService } from '../projects/portfolio/projects.service';
import { SitesService } from '../projects/sites/sites.service';

/**
 * The recruitment module's single seam onto every other module (Principle I).
 *
 * Employee creation and document verification go through `hr`, the F&F-processed
 * check through `hr`'s ExitService, document types / kit items / letter templates /
 * company name through `settings`, a joiner's branch through `projects`. Nothing in
 * `recruitment` reads another schema directly.
 */
@Injectable()
export class RecruitmentRefsService {
  constructor(
    private readonly employees: EmployeesService,
    private readonly employeeDocuments: EmployeeDocumentsService,
    private readonly exit: ExitService,
    private readonly documentTypes: DocumentTypesService,
    private readonly referenceData: ReferenceDataService,
    private readonly kitItems: KitItemsService,
    private readonly companies: CompaniesService,
    private readonly configService: ConfigService,
    private readonly projects: ProjectsService,
    private readonly sites: SitesService,
  ) {}

  private get config(): RecruitmentConfig {
    return this.configService.get<RecruitmentConfig>('recruitment');
  }

  get delayedJoiningThresholdDays(): number {
    return this.config.delayedJoiningThresholdDays;
  }
  get noShowGraceDays(): number {
    return this.config.noShowGraceDays;
  }
  get salaryBreakupToleranceRupees(): number {
    return this.config.salaryBreakupToleranceRupees;
  }

  /** Builds the HR `Caller` shape from an authenticated request. */
  callerFor(caller: AuthenticatedUser, ipAddress: string): Caller {
    return {
      userId: caller.id,
      // The company the caller is working in — the switcher's selection first (036 stream 3b).
      companyId: effectiveCompanyId(caller),
      ipAddress,
      rls: rlsContextFor(caller),
      roleIds: caller.roleIds ?? [],
    };
  }

  /** Creates the Employee record on joining, returning its id and generated code. */
  async createEmployee(
    caller: AuthenticatedUser,
    ipAddress: string,
    companyId: string,
    dto: CreateEmployeeDto,
  ): Promise<{ id: string; employeeCode: string }> {
    const created = await this.employees.create(
      this.callerFor(caller, ipAddress),
      companyId,
      dto,
    );
    return { id: created.id, employeeCode: created.employeeCode };
  }

  /**
   * The branch a new joiner is filed under (041): the requisition's project's, else the project
   * of the site they join at. Undefined — the head office — when neither names a project.
   */
  async branchForJoiner(
    caller: AuthenticatedUser,
    companyId: string,
    projectId: string | null,
    siteId: string,
  ): Promise<string | undefined> {
    const posting =
      projectId ??
      (await this.sites.getSiteById(rlsContextFor(caller), siteId)).projectId;
    return (await this.projects.branchIdOf(companyId, posting)) ?? undefined;
  }

  /** Stores a verified document against an employee via 005's document surface. */
  async uploadEmployeeDocument(
    caller: AuthenticatedUser,
    ipAddress: string,
    employeeId: string,
    dto: UploadEmployeeDocumentDto,
  ): Promise<void> {
    await this.employeeDocuments.upload(
      this.callerFor(caller, ipAddress),
      employeeId,
      dto,
    );
  }

  /** The company's document types — mandatory ones seed the onboarding checklist. */
  async listDocumentTypes(companyId: string) {
    return this.documentTypes.listForCompany(companyId);
  }

  /** The default kit items that seed a new onboarding checklist. */
  async defaultKitItems(
    caller: AuthenticatedUser,
    companyId: string,
    tx: Prisma.TransactionClient,
  ) {
    return this.kitItems.defaultsForCompany(caller, companyId, tx);
  }

  /** Whether the employee's F&F run is processed — gates relieving letters (FR-023). */
  async isFnfProcessed(
    caller: AuthenticatedUser,
    employeeId: string,
  ): Promise<boolean> {
    return this.exit.isFnfProcessed(rlsContextFor(caller), employeeId);
  }

  async companyName(companyId: string): Promise<string> {
    return this.companies.getName(companyId);
  }

  /** A designation's display name, for letter token substitution. */
  async designationName(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<string> {
    return this.referenceName(caller, 'designation', id);
  }

  /** A department's display name, for letter token substitution. */
  async departmentName(caller: AuthenticatedUser, id: string): Promise<string> {
    return this.referenceName(caller, 'department', id);
  }

  private async referenceName(
    caller: AuthenticatedUser,
    resource: 'designation' | 'department',
    id: string,
  ): Promise<string> {
    const rows = await this.referenceData.findAll(resource, caller);
    const match = rows.find((r) => (r as { id: string }).id === id);
    return match ? String((match as { name: string }).name) : '';
  }

  /** An employee's letter-relevant fields, read via 005's service. */
  async getEmployee(caller: AuthenticatedUser, employeeId: string) {
    return this.employees.getById(rlsContextFor(caller), employeeId);
  }

  /** Code and name for a set of employees, for a list naming who each row is about (2026-10-15). */
  async employeeNames(
    caller: AuthenticatedUser,
    employeeIds: string[],
  ): Promise<Map<string, { employeeCode: string; name: string }>> {
    return this.employees.namesByIds(rlsContextFor(caller), [
      ...new Set(employeeIds),
    ]);
  }

  /** The company's first configured shift id — the joining fallback when the
   * request supplies none (011 joining decision). Throws when none exists. */
  async defaultShiftId(caller: AuthenticatedUser): Promise<string> {
    const rows = await this.referenceData.findAll('shift', caller);
    const first = rows[0] as { id: string } | undefined;
    if (!first) {
      throw new BadRequestException(
        'No shift is configured; create one in Settings before joining an employee.',
      );
    }
    return first.id;
  }
}
