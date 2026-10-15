import { Injectable, NotFoundException } from '@nestjs/common';
import { CodeSeriesType } from '@prisma/client';
import { Prisma } from '@prisma/client';

import {
  CODE_SERIES_FORMATS,
  type CodeSeriesFormat,
  NAMED_SERIES_DEFAULT,
  type NamedSeries,
  type NamedSeriesFormat,
  formatCode,
} from './code-series.formats';

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
   * The format a company has set for a counted series in Settings → Numbering, else the built-in
   * one (2026-10-15). Null for a series nobody formats, which keeps `{shortCode}-{infix}-0001`.
   */
  async countedFormat(
    tx: Prisma.TransactionClient,
    companyId: string,
    seriesType: CodeSeriesType,
  ): Promise<CodeSeriesFormat | null> {
    const row = await tx.codeFormat.findUnique({
      where: { companyId_series: { companyId, series: seriesType } },
    });
    if (row) {
      return {
        prefix: row.prefix,
        base: row.base,
        step: row.step,
        width: row.width,
      };
    }
    return CODE_SERIES_FORMATS[seriesType] ?? null;
  }

  /** The format a company has set for machines or assets, else `JCB01/2027`'s. */
  async namedFormat(
    tx: Prisma.TransactionClient,
    companyId: string,
    series: NamedSeries,
  ): Promise<NamedSeriesFormat> {
    const row = await tx.codeFormat.findUnique({
      where: { companyId_series: { companyId, series } },
    });
    return row
      ? { width: row.width, separator: row.separator }
      : NAMED_SERIES_DEFAULT;
  }

  /**
   * The code the next allocation would give, without allocating it — what a creation form shows.
   * Steps over any code `isTaken` reports, as `next` does.
   */
  async peek(
    tx: Prisma.TransactionClient,
    companyId: string,
    seriesType: CodeSeriesType,
    isTaken?: (code: string) => Promise<boolean>,
  ): Promise<string | null> {
    const format = await this.countedFormat(tx, companyId, seriesType);
    if (!format) return null;
    const sequence = await tx.codeSequence.findUnique({
      where: { companyId_seriesType: { companyId, seriesType } },
      select: { lastNumber: true },
    });
    let n = (sequence?.lastNumber ?? 0) + 1;
    for (let guard = 0; guard < 10_000; guard += 1, n += 1) {
      const code = formatCode(format, n);
      if (!isTaken || !(await isTaken(code))) return code;
    }
    return null;
  }

  /**
   * Allocates the next code. `isTaken`, where given, steps over a code already held — a record
   * created with a typed code before the series was enforced, or one numbered under an earlier
   * format — rather than failing on the unique index (2026-10-15).
   */
  async next(
    tx: Prisma.TransactionClient,
    companyId: string,
    seriesType: CodeSeriesType,
    /** Ignored by a series with a format, which has no infix. */
    infix: string,
    isTaken?: (code: string) => Promise<boolean>,
  ): Promise<string> {
    for (let guard = 0; guard < 10_000; guard += 1) {
      const code = await this.allocate(tx, companyId, seriesType, infix);
      if (!isTaken || !(await isTaken(code))) return code;
    }
    throw new NotFoundException(
      `No free ${seriesType} code could be allocated for company ${companyId}`,
    );
  }

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
  private async allocate(
    tx: Prisma.TransactionClient,
    companyId: string,
    seriesType: CodeSeriesType,
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
    const format = await this.countedFormat(tx, companyId, seriesType);
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
