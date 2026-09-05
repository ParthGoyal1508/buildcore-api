import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LetterType, Prisma } from '@prisma/client';

import { AuthenticatedUser } from '../auth/authenticated-user';
import type { RecruitmentConfig } from '../common/configs/config.interface';
import { rlsContextFor } from '../common/prisma/rls-context';
import { CompaniesService } from '../settings/companies/companies.service';
import { DocumentTypesService } from '../settings/reference-data/document-types.service';
import { ReferenceDataService } from '../settings/reference-data/reference-data.service';
import { KitItemsService } from '../settings/kit-items/kit-items.service';
import { LetterTemplatesService } from '../settings/letter-templates/letter-templates.service';
import { EmployeesService } from '../hr/employees/employees.service';
import { EmployeeDocumentsService } from '../hr/employees/documents/employee-documents.service';
import { ExitService } from '../hr/offboarding/exit.service';
import type { Caller } from '../hr/biometrics/face-enrolment.service';
import type { CreateEmployeeDto } from '../hr/employees/dto/create-employee.dto';
import type { UploadEmployeeDocumentDto } from '../hr/employees/documents/dto/upload-document.dto';

/**
 * The recruitment module's single seam onto every other module (Principle I).
 *
 * Employee creation and document verification go through `hr`, the F&F-processed
 * check through `hr`'s ExitService, document types / kit items / letter templates /
 * company name through `settings`. Nothing in `recruitment` reads another schema
 * directly.
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
    private readonly letterTemplates: LetterTemplatesService,
    private readonly companies: CompaniesService,
    private readonly configService: ConfigService,
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
      companyId: caller.companyId,
      ipAddress,
      rls: rlsContextFor(caller),
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

  /** The active letter template for a type, or null (the caller raises 409). */
  async getActiveTemplate(
    companyId: string,
    letterType: LetterType,
    tx: Prisma.TransactionClient,
  ) {
    return this.letterTemplates.getActive(companyId, letterType, tx);
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
