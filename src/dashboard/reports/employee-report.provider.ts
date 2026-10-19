import { Injectable } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { EmployeesService } from '../../hr/employees/employees.service';
import { ReferenceDataService } from '../../settings/reference-data/reference-data.service';
import type { DashboardContext } from '../context';
import type { FilterSpec, ReportData, ReportProvider } from './report.types';

/**
 * The Employee report (spec FR-019, US7): the company's active employees with their
 * code, name, department, designation and joining date, read through `hr`'s and
 * `settings`' exported services (Principle I).
 */
@Injectable()
export class EmployeeReportProvider implements ReportProvider {
  readonly id = 'employee';
  readonly name = 'Employee';
  /** `EMPLOYEES` — this is the roster, with joining dates, as a download. */
  readonly requires = [Permission.EMPLOYEES];
  readonly filters: FilterSpec[] = [];

  constructor(
    private readonly employees: EmployeesService,
    private readonly references: ReferenceDataService,
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async run(ctx: DashboardContext): Promise<ReportData> {
    /**
     * The two masters are read **once for the whole report**, not per row.
     *
     * `listForReport` returns `departmentId` and `designationId`, and both were being
     * placed straight into columns headed "Department" and "Designation" — so the one
     * report of the roster that anybody can export arrived with
     * `cmu40n39a0030123nt0se33v5` in those two columns, in a file people send to each
     * other. Same defect the Activity Log had in its User column.
     */
    const [rows, departments, designations] = await Promise.all([
      this.employees.listForReport(ctx.rls, ctx.companyId),
      this.references.findAll('department', ctx.user),
      this.references.findAll('designation', ctx.user),
    ]);

    const nameById = (master: Record<string, unknown>[]) =>
      new Map(
        master.map((row) => [String(row.id), String(row.name ?? '')] as const),
      );
    const departmentName = nameById(departments);
    const designationName = nameById(designations);

    return {
      columns: [
        { key: 'employeeCode', label: 'Code' },
        { key: 'name', label: 'Name' },
        { key: 'department', label: 'Department' },
        { key: 'designation', label: 'Designation' },
        { key: 'dateOfJoining', label: 'Joining Date', type: 'date' },
      ],
      rows: rows.map((r) => ({
        employeeCode: r.employeeCode,
        name: r.name,
        // An id with no master row left behind — a department deleted after the
        // employee was filed under it — reads as blank rather than as a cuid.
        department: r.departmentId
          ? departmentName.get(r.departmentId) ?? ''
          : '',
        designation: r.designationId
          ? designationName.get(r.designationId) ?? ''
          : '',
        dateOfJoining: r.dateOfJoining
          ? r.dateOfJoining.toISOString().slice(0, 10)
          : '',
      })),
    };
  }
}
