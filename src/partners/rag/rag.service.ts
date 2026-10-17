import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { monthLabel } from '../../common/form-document/form-format';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { companyScope } from '../../settings/company-scope';

export type RagCellStatus =
  | 'verified'
  | 'submitted'
  | 'partial'
  | 'missing'
  | 'gray';

export interface RagMatrixResponse {
  fy: string;
  months: string[];
  rows: Array<{
    contractorProfileId: string;
    contractorName: string;
    cells: Array<{
      month: string;
      status: RagCellStatus;
      complianceId: string | null;
    }>;
  }>;
}

/** What a cell reads as in the Excel export — words, since a sheet has no coloured dots. */
const RAG_EXPORT_LABELS: Record<RagCellStatus, string> = {
  verified: 'Verified',
  submitted: 'Submitted',
  partial: 'Partial',
  missing: 'Missing',
  gray: 'Not due',
};

/** Cell fills for the export, matching the screen's dots so the sheet reads the same way. */
const RAG_EXPORT_FILLS: Record<RagCellStatus, string | null> = {
  verified: 'FFC6EFCE',
  submitted: 'FFDDEBF7',
  partial: 'FFFFEB9C',
  missing: 'FFFFC7CE',
  gray: null,
};

const FY_REGEX = /^(\d{4})-(\d{2})$/;

/**
 * Expands an Indian financial year label into its twelve `YYYY-MM` months.
 *
 * `2025-26` is April 2025 through March 2026. The second half is a two-digit year and
 * is checked against the first: `2025-27` is rejected rather than quietly treated as
 * a two-year span.
 */
export function financialYearMonths(fy: string): string[] {
  const match = FY_REGEX.exec(fy);
  if (!match) {
    throw new BadRequestException('fy must look like 2025-26');
  }
  const startYear = Number(match[1]);
  const endShort = Number(match[2]);
  if ((startYear + 1) % 100 !== endShort) {
    throw new BadRequestException(
      `fy ${fy} is not a single financial year — expected ${startYear}-${String(
        (startYear + 1) % 100,
      ).padStart(2, '0')}`,
    );
  }
  const months: string[] = [];
  for (let offset = 0; offset < 12; offset += 1) {
    const date = new Date(Date.UTC(startYear, 3 + offset, 1));
    months.push(
      `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
        2,
        '0',
      )}`,
    );
  }
  return months;
}

/** `YYYY-MM` of the current calendar month, the boundary past which a cell is gray. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(
    2,
    '0',
  )}`;
}

/**
 * The compliance matrix: contractors down, months across (007 US5).
 *
 * Computed on demand rather than materialised. The inputs are a few hundred rows and
 * the answer changes on every filing, so a stored matrix would be a cache that is
 * wrong more often than it is right.
 *
 * A month later than the current one is `gray`, not `missing` — a filing that is not
 * yet due has not been missed, and colouring it red would put every contractor
 * permanently in breach for the rest of the year.
 */
@Injectable()
export class RagService {
  constructor(private readonly prisma: PrismaService) {}

  async buildMatrix(
    caller: AuthenticatedUser,
    fy: string,
    companyId?: string,
    now: Date = new Date(),
  ): Promise<RagMatrixResponse> {
    const months = financialYearMonths(fy);
    const thisMonth = currentMonth(now);

    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const contractors = await tx.contractorProfile.findMany({
        where: {
          ...companyScope(caller, companyId),
          // Same rule the contractor list applies: an ended engagement does not
          // belong on a compliance report.
          vendor: { active: true },
        },
        select: {
          id: true,
          vendor: { select: { name: true } },
        },
        orderBy: { vendor: { name: 'asc' } },
      });

      if (contractors.length === 0) {
        return { fy, months, rows: [] };
      }

      // One batched query for the whole grid rather than one per cell: twelve months
      // times N contractors would otherwise be 12N round trips.
      const records = await tx.monthlyCompliance.findMany({
        where: {
          contractorProfileId: { in: contractors.map((c) => c.id) },
          month: { in: months },
        },
        select: {
          id: true,
          contractorProfileId: true,
          month: true,
          status: true,
        },
      });

      const byKey = new Map(
        records.map((record) => [
          `${record.contractorProfileId}:${record.month}`,
          record,
        ]),
      );

      return {
        fy,
        months,
        rows: contractors.map((contractor) => ({
          contractorProfileId: contractor.id,
          contractorName: contractor.vendor.name,
          cells: months.map((month) => {
            if (month > thisMonth) {
              return {
                month,
                status: 'gray' as RagCellStatus,
                complianceId: null,
              };
            }
            const record = byKey.get(`${contractor.id}:${month}`);
            if (!record) {
              return {
                month,
                status: 'missing' as RagCellStatus,
                complianceId: null,
              };
            }
            return {
              month,
              status: record.status as RagCellStatus,
              complianceId: record.id,
            };
          }),
        })),
      };
    });
  }

  /**
   * The same matrix as an Excel sheet (036 N6, 2026-10-17): the regulator-facing copy of the
   * screen, one row per contractor and one column per month, each cell a word with the
   * screen's colour behind it. Built from `buildMatrix`, so the two can never disagree.
   */
  async exportXlsx(
    caller: AuthenticatedUser,
    fy: string,
    companyId?: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const matrix = await this.buildMatrix(caller, fy, companyId);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`RAG ${matrix.fy}`, {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
    });
    ws.columns = [
      { header: 'Contractor', key: 'contractor', width: 32 },
      ...matrix.months.map((month) => ({
        header: monthLabel(month),
        key: month,
        width: 15,
      })),
    ];
    ws.getRow(1).font = { bold: true };
    for (const row of matrix.rows) {
      const added = ws.addRow({
        contractor: row.contractorName,
        ...Object.fromEntries(
          row.cells.map((cell) => [cell.month, RAG_EXPORT_LABELS[cell.status]]),
        ),
      });
      row.cells.forEach((cell, index) => {
        const fill = RAG_EXPORT_FILLS[cell.status];
        if (!fill) return;
        added.getCell(index + 2).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: fill },
        };
      });
    }
    return {
      buffer: Buffer.from(await wb.xlsx.writeBuffer()),
      filename: `RAG_Matrix_${matrix.fy}.xlsx`,
    };
  }
}
