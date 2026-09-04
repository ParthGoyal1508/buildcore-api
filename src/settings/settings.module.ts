import { Module } from '@nestjs/common';
import { AuditLogService } from '../auth/audit-log.service';
import { UsersModule } from '../users/users.module';
import { CodeSeriesService } from './code-series/code-series.service';
import { CompaniesController } from './companies/companies.controller';
import { CompaniesService } from './companies/companies.service';
import { EmployeeCodeService } from './employee-code/employee-code.service';
import { DepartmentsController } from './reference-data/departments.controller';
import { DesignationsController } from './reference-data/designations.controller';
import { DocumentTypesController } from './reference-data/document-types.controller';
import { DocumentTypesService } from './reference-data/document-types.service';
import { ReferenceDataService } from './reference-data/reference-data.service';
import { ShiftsController } from './reference-data/shifts.controller';
import { ReimbursementCategoriesController } from './reimbursement-categories/reimbursement-categories.controller';
import { ReimbursementCategoriesService } from './reimbursement-categories/reimbursement-categories.service';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { UsersAdminController } from './users-admin/users-admin.controller';
import { UsersAdminService } from './users-admin/users-admin.service';
import { ItemCategoriesService } from './item-masters/item-categories.service';
import { ItemsService } from './item-masters/items.service';
import { VendorCategoriesService } from './vendor-categories/vendor-categories.service';
import { SkillCategoriesService } from './skill-categories/skill-categories.service';

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
    ReimbursementCategoriesController,
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
    CodeSeriesService,
    VendorCategoriesService,
    ItemCategoriesService,
    ItemsService,
    AuditLogService,
    SkillCategoriesService,
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
    // Exported for `partners`: the vendor category master lives here because it is a
    // company master edited under Settings, and code-series allocation is the
    // generalised form of the employee-code allocator beside it (007 research.md §1).
    VendorCategoriesService,
    // Exported for `inventory`, whose category and item masters are settings-schema
    // tables for the reason 009 research.md §1 gives — the same arrangement vendor
    // categories already have.
    ItemCategoriesService,
    ItemsService,
    CodeSeriesService,
    // Exported for `labour`, which owns the skill-category endpoints and the
    // deletion-in-use guard while the table itself is a `settings` master (013
    // research/data-model), mirroring the item-master arrangement above.
    SkillCategoriesService,
  ],
})
export class SettingsModule {}
