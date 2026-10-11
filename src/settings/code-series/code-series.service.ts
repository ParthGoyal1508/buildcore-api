import { Injectable, NotFoundException } from '@nestjs/common';
import { CodeSeriesType } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { CODE_SERIES_FORMATS, formatCode } from './code-series.formats';

/**
 * Per-company numbering series, allocated atomically.
 *
 * Generalises `EmployeeCodeService`, which stays as it is: it predates this table,
 * carries its own 1:1 relation to Company, and rewriting a working allocator that
 * production codes already depend on would risk renumbering real employees for a
 * tidier abstraction. New series start here instead — vendors today, project codes
 * when 008 lands.
 *
 * Takes a transaction client rather than injecting `PrismaService`, because a code
 * must be allocated inside the same transaction as the row that will carry it. A
 * separate transaction would hand out a number that a subsequent rollback silently
 * burns, leaving gaps in a sequence people read as evidence of deleted records.
 */
@Injectable()
export class CodeSeriesService {
  /**
   * Advances a company's series and returns the formatted code.
   *
   * The increment and the read are one `UPDATE ... RETURNING`, which Postgres
   * serializes per row without explicit locking — concurrent callers cannot observe
   * the same number twice, and none is skipped.
   *
   * The prefix is read after the counter moves, so editing a company's short code
   * changes only the prefix of subsequent codes and leaves the sequence unbroken —
   * the same rule employee codes follow.
   */
  async next(
    tx: Prisma.TransactionClient,
    companyId: string,
    seriesType: CodeSeriesType,
    /** Ignored by a series listed in `CODE_SERIES_FORMATS`, which has no infix. */
    infix: string,
  ): Promise<string> {
    // Created on first use rather than seeded per company: a series that no feature
    // has allocated from yet has no meaningful row, and requiring a seed step would
    // make every new company's first vendor fail until someone remembered it.
    await tx.codeSequence.upsert({
      where: { companyId_seriesType: { companyId, seriesType } },
      create: { companyId, seriesType, lastNumber: 0 },
      update: {},
    });

    const rows = await tx.$queryRaw<{ lastNumber: number }[]>`
      UPDATE "settings"."CodeSequence"
      SET "lastNumber" = "lastNumber" + 1, "updatedAt" = NOW()
      WHERE "companyId" = ${companyId} AND "seriesType" = ${seriesType}::"settings"."CodeSeriesType"
      RETURNING "lastNumber"
    `;
    if (rows.length === 0) {
      throw new NotFoundException(
        `No ${seriesType} code sequence exists for company ${companyId}`,
      );
    }

    // A series the business has specified a format for renders from the table and
    // never reads the company at all (2026-10-11). The short code is deliberately
    // absent from those three: `@@unique([companyId, code])` is what keeps two
    // companies apart, not the prefix, and the people quoting a vendor code down the
    // phone do not want four more characters in front of it.
    const format = CODE_SERIES_FORMATS[seriesType];
    if (format) return formatCode(format, rows[0].lastNumber);

    const company = await tx.company.findUnique({
      where: { id: companyId },
      select: { shortCode: true },
    });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} not found`);
    }

    return `${company.shortCode}-${infix}-${String(rows[0].lastNumber).padStart(
      4,
      '0',
    )}`;
  }
}
