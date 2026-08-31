import { Module } from '@nestjs/common';
import { HrModule } from '../hr/hr.module';
import { SalaryPdfService } from './salary/salary-pdf.service';
import { SalaryController } from './salary/salary.controller';
import { SalaryService } from './salary/salary.service';

/**
 * The `payroll` module. Feature 003 gives it only its read side: an employee
 * fetching their own payslip.
 *
 * `HrModule` is imported for `EmployeesService` — resolving "which employee is
 * asking" is `hr`'s job, and Principle I routes the question through its exported
 * service rather than letting `payroll` query `hr.Employee` itself.
 */
@Module({
  imports: [HrModule],
  controllers: [SalaryController],
  providers: [SalaryService, SalaryPdfService],
  exports: [SalaryService],
})
export class PayrollModule {}
