import { BadRequestException, Injectable } from '@nestjs/common';
import { AttendanceStatusOverride } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../../common/prisma/rls-context';
import type { Caller } from '../biometrics/face-enrolment.service';
import { AttendanceAdminService } from './attendance-admin.service';

/** One parsed CSV row plus whatever was wrong with it. */
export interface ImportRowResult {
  rowNumber: number;
  employeeCode: string;
  date: string;
  inTime: string | null;
  outTime: string | null;
  status: string | null;
  remarks: string | null;
  /** Resolved during validation; absent when the code did not match. */
  employeeId?: string;
  errors: string[];
}

export interface ValidationResult {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  rows: ImportRowResult[];
}

const HEADERS = [
  'employeeCode',
  'date',
  'inTime',
  'outTime',
  'status',
  'remarks',
] as const;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ONLY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Bulk attendance import (005 US13).
 *
 * Two explicit phases — validate, then commit — rather than one upload that
 * partially succeeds. A half-imported month is worse than a rejected file:
 * whoever uploaded it has no way to know which rows landed, and re-uploading
 * double-counts.
 *
 * Commit goes through the same `AttendanceAdminService.mark()` the manual screen
 * uses, so imported rows obey the payroll lock, the mandatory-document gate, and
 * write the same Modifications audit entries. An import that bypassed those would
 * be a way around every rule the admin screen enforces.
 */
@Injectable()
export class AttendanceImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendanceAdminService,
  ) {}

  /** The CSV template, header row only (FR-041). */
  getTemplate(): string {
    return `${HEADERS.join(',')}\n`;
  }

  /**
   * Parses and checks a file without writing anything (FR-042).
   *
   * Every row is reported, valid or not, so the caller sees the whole picture
   * rather than just the first failure.
   */
  async validate(
    caller: Caller,
    companyId: string,
    csv: string,
  ): Promise<ValidationResult> {
    const lines = csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      throw new BadRequestException('The file is empty.');
    }

    const header = lines[0].split(',').map((h) => h.trim());
    const missing = HEADERS.filter((h) => !header.includes(h));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing required column(s): ${missing.join(', ')}. Download the template.`,
      );
    }
    const index = Object.fromEntries(
      HEADERS.map((h) => [h, header.indexOf(h)]),
    ) as Record<(typeof HEADERS)[number], number>;

    const employees = await withRlsContext(this.prisma, caller.rls, (tx) =>
      tx.employee.findMany({
        where: { companyId, isActive: true },
        select: { id: true, employeeCode: true },
      }),
    );
    const byCode = new Map(employees.map((e) => [e.employeeCode, e.id]));

    // Catches a file that lists the same employee-day twice — the second row
    // would silently overwrite the first on commit.
    const seen = new Set<string>();
    const rows: ImportRowResult[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',').map((c) => c.trim());
      const get = (h: (typeof HEADERS)[number]) => cells[index[h]] ?? '';

      const row: ImportRowResult = {
        rowNumber: i + 1,
        employeeCode: get('employeeCode'),
        date: get('date'),
        inTime: get('inTime') || null,
        outTime: get('outTime') || null,
        status: get('status') || null,
        remarks: get('remarks') || null,
        errors: [],
      };

      if (!row.employeeCode) {
        row.errors.push('employeeCode is required');
      } else {
        const id = byCode.get(row.employeeCode);
        if (!id) {
          row.errors.push(
            `No active employee with code ${row.employeeCode} in this company`,
          );
        } else {
          row.employeeId = id;
        }
      }

      if (!DATE_ONLY.test(row.date)) {
        row.errors.push('date must be YYYY-MM-DD');
      }
      if (row.inTime && !TIME_ONLY.test(row.inTime)) {
        row.errors.push('inTime must be HH:mm');
      }
      if (row.outTime && !TIME_ONLY.test(row.outTime)) {
        row.errors.push('outTime must be HH:mm');
      }
      if (row.inTime && row.outTime && row.outTime < row.inTime) {
        row.errors.push('outTime cannot precede inTime');
      }
      if (
        row.status &&
        !Object.values(AttendanceStatusOverride).includes(
          row.status as AttendanceStatusOverride,
        )
      ) {
        row.errors.push(
          `status must be one of ${Object.values(AttendanceStatusOverride).join(', ')}`,
        );
      }
      if (!row.inTime && !row.outTime && !row.status) {
        row.errors.push(
          'Provide at least one of inTime, outTime or status',
        );
      }

      const key = `${row.employeeCode}|${row.date}`;
      if (seen.has(key)) {
        row.errors.push('Duplicate row for this employee and date');
      }
      seen.add(key);

      rows.push(row);
    }

    const invalid = rows.filter((r) => r.errors.length > 0).length;
    return {
      totalRows: rows.length,
      validRows: rows.length - invalid,
      invalidRows: invalid,
      rows,
    };
  }

  /**
   * Commits a previously validated file (FR-043).
   *
   * Re-validates rather than trusting the client's word that it passed: the
   * validate and commit calls are separate requests, and nothing stops a caller
   * sending a different file the second time.
   *
   * Refuses outright if any row is invalid, rather than importing the good ones —
   * a partial import leaves the operator unable to tell what landed.
   */
  async commit(
    caller: Caller,
    companyId: string,
    csv: string,
  ): Promise<{ imported: number; failed: ImportRowResult[] }> {
    const validation = await this.validate(caller, companyId, csv);
    if (validation.invalidRows > 0) {
      throw new BadRequestException({
        message:
          'The file still has invalid rows. Fix them and upload again — nothing was imported.',
        invalidRows: validation.invalidRows,
        rows: validation.rows.filter((r) => r.errors.length > 0),
      });
    }

    const failed: ImportRowResult[] = [];
    let imported = 0;

    for (const row of validation.rows) {
      try {
        // Same path as the manual screen, so the payroll lock (FR-044), the
        // mandatory-document gate and the Modifications audit all apply.
        await this.attendance.mark(caller, {
          employeeId: row.employeeId!,
          date: row.date,
          inTime: row.inTime ?? undefined,
          outTime: row.outTime ?? undefined,
          statusOverride:
            (row.status as AttendanceStatusOverride | null) ?? undefined,
          remarks: row.remarks ?? 'Bulk import',
        });
        imported++;
      } catch (e) {
        // A row rejected by a rule the CSV cannot see — a locked payroll period,
        // missing mandatory documents — is reported rather than aborting the run,
        // because the remaining rows are still legitimate.
        failed.push({
          ...row,
          errors: [(e as Error).message ?? 'Rejected'],
        });
      }
    }

    return { imported, failed };
  }
}
