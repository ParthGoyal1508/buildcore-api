import { Module } from '@nestjs/common';
import { AuditLogService } from '../auth/audit-log.service';
import { HrModule } from '../hr/hr.module';
import { SettingsModule } from '../settings/settings.module';
import { ChallansController } from './challans/challans.controller';
import { ChallansService } from './challans/challans.service';
import { PayrollEngineService } from './engine/payroll-engine.service';
import { LoansController } from './loans/loans.controller';
import { LoansService } from './loans/loans.service';
import { FnfController } from './offboarding/fnf.controller';
import { FnfService } from './offboarding/fnf.service';
import { ReimbursementsAdminController } from './reimbursements-admin/reimbursements-admin.controller';
import { ReimbursementsAdminService } from './reimbursements-admin/reimbursements-admin.service';
import { SalaryAdvancesController } from './advances/salary-advances.controller';
import { SalaryAdvancesService } from './advances/salary-advances.service';
import { PayrollRegisterController } from './registers/payroll-register.controller';
import { PayrollRegisterService } from './registers/payroll-register.service';
import { TdsController } from './tds/tds.controller';
import { TdsService } from './tds/tds.service';
import { BankSheetService } from './runs/bank-sheet.service';
import { PayrollRunsController } from './runs/payroll-runs.controller';
import { SalaryPdfService } from './salary/salary-pdf.service';
import { SalaryController } from './salary/salary.controller';
import { SalaryService } from './salary/salary.service';

/**
 * The `payroll` module.
 *
 * Feature 003 gave it only its read side (an employee fetching their own payslip);
 * feature 005 adds the calculation engine and the run lifecycle behind it.
 *
 * `HrModule` supplies `EmployeesService`, `AttendanceHistoryService` and
 * `PiiCipherService`; `SettingsModule` supplies the per-company payroll rates.
 * Both are service calls rather than cross-schema queries — Principle I.
 */
@Module({
  imports: [HrModule, SettingsModule],
  controllers: [
    SalaryController,
    PayrollRunsController,
    ChallansController,
    LoansController,
    FnfController,
    ReimbursementsAdminController,
    TdsController,
    SalaryAdvancesController,
    PayrollRegisterController,
  ],
  providers: [
    SalaryService,
    SalaryPdfService,
    PayrollEngineService,
    BankSheetService,
    ChallansService,
    LoansService,
    FnfService,
    ReimbursementsAdminService,
    TdsService,
    SalaryAdvancesService,
    PayrollRegisterService,
    AuditLogService,
  ],
  // Exported so 008's Project P&L can read labour cost by project without
  // querying `payroll.PayrollLineItem` itself (FR-046).
  exports: [SalaryService, PayrollEngineService],
})
export class PayrollModule {}
