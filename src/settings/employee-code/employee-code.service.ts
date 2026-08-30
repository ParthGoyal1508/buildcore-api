import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';

/** Read-only view of a company's code series, for the admin-visible state endpoint
 * (User Story 7) — deliberately separate from `getNextEmployeeCode()` so looking at
 * the sequence can never consume a number. */
export interface EmployeeCodeSeriesState {
  companyId: string;
  shortCode: string;
  lastNumber: number;
  /** What the *next* generated code would be — a preview, not a reservation. */
  nextCode: string;
}

/** Zero-padded to 4 digits per FR-023 (`DC-0001`). Wider numbers simply grow past
 * the padding rather than being truncated. */
function formatEmployeeCode(shortCode: string, sequence: number): string {
  return `${shortCode}-${String(sequence).padStart(4, '0')}`;
}

@Injectable()
export class EmployeeCodeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Allocates the next employee code for a company (FR-023), exported from
   * `SettingsModule` for the future Employees module to call on employee creation.
   *
   * The increment and the read happen in one atomic `UPDATE ... RETURNING`
   * statement, which Postgres serializes per row without explicit locking — so
   * concurrent callers can never observe the same `lastNumber` twice, and no number
   * is skipped (research.md §6, SC-007's 1,000-concurrent target).
   *
   * The prefix is read from the company *after* the counter moves, so editing a
   * company's short code changes only the prefix of subsequent codes and leaves the
   * sequence itself running unbroken (FR-024).
   */
  async getNextEmployeeCode(
    companyId: string,
    ctx: RlsContext = { isSuperAdmin: true },
  ): Promise<string> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const rows = await tx.$queryRaw<{ lastNumber: number }[]>`
        UPDATE "settings"."EmployeeCodeSequence"
        SET "lastNumber" = "lastNumber" + 1
        WHERE "companyId" = ${companyId}
        RETURNING "lastNumber"
      `;

      if (rows.length === 0) {
        throw new NotFoundException(
          `No employee code sequence exists for company ${companyId}`,
        );
      }

      const company = await tx.company.findUnique({
        where: { id: companyId },
        select: { shortCode: true },
      });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} not found`);
      }

      return formatEmployeeCode(company.shortCode, rows[0].lastNumber);
    });
  }

  /** Current series state without consuming a number (User Story 7). */
  async getCurrentState(
    companyId: string,
    ctx: RlsContext = { isSuperAdmin: true },
  ): Promise<EmployeeCodeSeriesState> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const company = await tx.company.findUnique({
        where: { id: companyId },
        select: { shortCode: true },
      });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} not found`);
      }

      const sequence = await tx.employeeCodeSequence.findUnique({
        where: { companyId },
        select: { lastNumber: true },
      });
      const lastNumber = sequence?.lastNumber ?? 0;

      return {
        companyId,
        shortCode: company.shortCode,
        lastNumber,
        nextCode: formatEmployeeCode(company.shortCode, lastNumber + 1),
      };
    });
  }
}
