import { Module } from '@nestjs/common';
import { AuditLogService } from '../auth/audit-log.service';
import { UsersModule } from '../users/users.module';
import { CompaniesController } from './companies/companies.controller';
import { CompaniesService } from './companies/companies.service';
import { EmployeeCodeService } from './employee-code/employee-code.service';
import { DepartmentsController } from './reference-data/departments.controller';
import { DesignationsController } from './reference-data/designations.controller';
import { DocumentTypesController } from './reference-data/document-types.controller';
import { DocumentTypesService } from './reference-data/document-types.service';
import { ReferenceDataService } from './reference-data/reference-data.service';
import { ShiftsController } from './reference-data/shifts.controller';
import { ReimbursementCategoriesService } from './reimbursement-categories/reimbursement-categories.service';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { UsersAdminController } from './users-admin/users-admin.controller';
import { UsersAdminService } from './users-admin/users-admin.service';

/**
 * The `settings` module: companies, roles, user administration, and the four
 * per-company Employee Setup masters.
 *
 * `UsersModule` is imported rather than `shared.User` being queried directly —
 * Principle I routes every cross-module read through the owning module's exported
 * service. The three services exported below are this module's own outward
 * contract: role lookup for Auth, active companies for other modules' dropdowns,
 * employee-code allocation and the mandatory-document check for the future
 * Employees module.
 */
@Module({
  imports: [UsersModule],
  controllers: [
    CompaniesController,
    RolesController,
    UsersAdminController,
    DepartmentsController,
    DesignationsController,
    DocumentTypesController,
    ShiftsController,
  ],
  providers: [
    CompaniesService,
    RolesService,
    UsersAdminService,
    ReferenceDataService,
    DocumentTypesService,
    EmployeeCodeService,
    ReimbursementCategoriesService,
    AuditLogService,
  ],
  exports: [
    RolesService,
    CompaniesService,
    EmployeeCodeService,
    DocumentTypesService,
    // Exported for `hr`, which reads a shift's duration to compute overtime
    // (research.md §9) — a service call rather than a cross-schema query.
    ReferenceDataService,
    // Exported for `hr`'s reimbursement claims, which validate their
    // mandatory-receipt rule against this master (research.md §10).
    ReimbursementCategoriesService,
  ],
})
export class SettingsModule {}
