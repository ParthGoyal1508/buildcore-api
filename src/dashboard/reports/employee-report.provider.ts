import { Injectable } from '@nestjs/common';

import { EmployeesService } from '../../hr/employees/employees.service';
import type { DashboardContext } from '../context';
import type { FilterSpec, ReportData, ReportProvider } from './report.types';

/**
 * The Employee report (spec FR-019, US7): the company's active employees with their
 * code, name, department/designation ids and joining date, read through `hr`'s
 * exported service (Principle I).
 */
@Injectable()
export class EmployeeReportProvider implements ReportProvider {
  readonly id = 'employee';
  readonly name = 'Employee';
  readonly filters: FilterSpec[] = [];

  constructor(private readonly employees: EmployeesService) {}

  isAvailable(): boolean {
    return true;
  }

  async run(ctx: DashboardContext): Promise<ReportData> {
    const rows = await this.employees.listForReport(ctx.rls, ctx.companyId);
    return {
      columns: [
        { key: 'employeeCode', label: 'Code' },
        { key: 'name', label: 'Name' },
        { key: 'departmentId', label: 'Department' },
        { key: 'designationId', label: 'Designation' },
        { key: 'dateOfJoining', label: 'Joining Date' },
      ],
      rows: rows.map((r) => ({
        employeeCode: r.employeeCode,
        name: r.name,
        departmentId: r.departmentId ?? '',
        designationId: r.designationId ?? '',
        dateOfJoining: r.dateOfJoining
          ? r.dateOfJoining.toISOString().slice(0, 10)
          : '',
      })),
    };
  }
}
