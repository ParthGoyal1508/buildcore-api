import { Module, forwardRef } from '@nestjs/common';
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
import { ApprovalsModule } from '../approvals/approvals.module';
import { BankSheetService } from './runs/bank-sheet.service';
import { PayrollRunsController } from './runs/payroll-runs.controller';
import { PayrollScheduleCron } from './runs/payroll-schedule.cron';
import { PayrollScheduleService } from './runs/payroll-schedule.service';
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
  // ApprovalsModule for feature 016: a payroll run travels Site Incharge → HR →
  // Director before it can produce a bank sheet, and the run is submitted into that
  // chain through `ApprovalService` rather than by writing to the spine's tables.
  imports: [forwardRef(() => HrModule), SettingsModule, ApprovalsModule],
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
    PayrollScheduleService,
    PayrollScheduleCron,
    AuditLogService,
  ],
  // Exported so 008's Project P&L can read labour cost by project without
  // querying `payroll.PayrollLineItem` itself (FR-046). `ReimbursementsAdminService`
  // is exported for 004's Pending Approvals KPI, which counts submitted reimbursement
  // claims (FR-005, research.md §8).
  // `PayrollScheduleService` is exported for `hr` (016 FR-016): the attendance write
  // path must ask whether a date falls in a period under payroll review, and Principle I
  // forbids it from reading `payroll` tables to find out (research.md §5).
  exports: [
    SalaryService,
    PayrollEngineService,
    ReimbursementsAdminService,
    PayrollScheduleService,
  ],
})
export class PayrollModule {}
