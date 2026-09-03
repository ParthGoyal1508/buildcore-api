import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
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
}
