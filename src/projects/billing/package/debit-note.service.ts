import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BillPackageStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../../common/prisma/rls-context';
import { withRlsContext } from '../../../common/prisma/rls-context';
import { packageLabel } from './bill-package.service';
import { PACKAGE_ERRORS } from './package-error-codes';

export interface RecordDebitInput {
  projectId: string;
  /** "Debit against the ATMS Equipment Missing at site" (FR-040). */
  groupHeading?: string | null;
  description: string;
  location?: string | null;
  nos?: string | null;
  length?: string | null;
  width?: string | null;
  quantity?: string | null;
  unit?: string | null;
  rate: string;
  amount: string;
  /**
   * Carried rather than computed (FR-036).
   *
   * The real register shows both, and the tax on a debit is not always the bill's own rate — a
   * stolen item is charged at the rate it was bought at. Deriving it here would quietly re-rate
   * every historical debit the first time a statute changed.
   */
  amountWithTax: string;
}

export interface DebitRow {
  id: string;
  groupHeading: string | null;
  description: string;
  location: string | null;
  nos: string | null;
  length: string | null;
  width: string | null;
  quantity: string | null;
  unit: string | null;
  rate: string;
  amount: string;
  amountWithTax: string;
  /** The package it was recovered on, where it has been — "RA-07" (FR-039). */
  recoveredOn: string | null;
  recoveredOnPackageId: string | null;
  recordedAt: string;
}

/** The register, grouped under its headings (FR-040). */
export interface DebitRegister {
  packageId: string;
  /**
   * **`true` where the package has been issued**, in which case this register is the register *as
   * at issue* (FR-039a) rather than the project's current one.
   */
  asAtIssue: boolean;
  groups: { heading: string | null; rows: DebitRow[] }[];
  /** What this package itself recovers — the figure block B's mechanical debit carries (FR-038). */
  recoveredOnThisPackage: string;
  /** Every debit on the project, recovered or not. The running total is the point of a register. */
  total: string;
}

const ZERO = new Prisma.Decimal(0);

/**
 * The debit-note register (023 US5, FR-036 to FR-040a).
 *
 * ## The two rules that are about money rather than bookkeeping
 *
 * **A debit is recovered on exactly one bill** (FR-037), and the rule is enforced by a conditional
 * update whose row count is checked — not by reading the row and then writing it. Two callers
 * applying one debit at the same moment both pass a read-then-write check, and the second write
 * silently replaces the first: the debit is then recovered on two bills, which is money taken
 * twice. FR-037a exists because the sequential statement of the rule ("refuse a second
 * application") reads as though that case were covered, and it is not.
 *
 * **An issued package's register is frozen at issue** (FR-039a). FR-039 wants every debit on the
 * project visible from any bill, because the running total is the point; FR-028 wants a bill
 * produced twice to be identical. Those two cannot both hold for an issued bill while the register
 * is live — a debit recorded between two productions of a signed document would change it. So the
 * register is live for a draft and `recordedAt <= issuedAt` for an issued one. The checklist found
 * this contradiction (CHK025) and quickstart Pass 6 had been asserting the behaviour that caused it.
 */
@Injectable()
export class DebitNoteService {
  constructor(private readonly prisma: PrismaService) {}

  /** Records a debit against a project. Not yet recovered on anything. */
  async record(
    ctx: RlsContext,
    companyId: string,
    userId: string | null,
    input: RecordDebitInput,
  ): Promise<DebitRow> {
    const created = await withRlsContext(this.prisma, ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: input.projectId },
        select: { id: true },
      });
      // 404 and not 403 (FR-053).
      if (!project) throw new NotFoundException('Project not found');

      return tx.billPackageDebit.create({
        data: {
          companyId,
          projectId: input.projectId,
          groupHeading: input.groupHeading ?? null,
          description: input.description,
          location: input.location ?? null,
          nos: input.nos ?? null,
          length: input.length ?? null,
          width: input.width ?? null,
          quantity: input.quantity ?? null,
          unit: input.unit ?? null,
          rate: input.rate,
          amount: input.amount,
          amountWithTax: input.amountWithTax,
          recordedByUserId: userId,
        },
      });
    });
    return toRow(created);
  }

  /**
   * Applies a debit to one package (FR-037, FR-037a, FR-037b, FR-038).
   *
   * **One statement decides it.** `WHERE "recoveredOnPackageId" IS NULL` means the database
   * arbitrates, so of two simultaneous applications exactly one updates a row and the other updates
   * none — and the one that updated none is the one refused. A read followed by a write would let
   * both through.
   */
  async apply(
    ctx: RlsContext,
    debitId: string,
    packageId: string,
  ): Promise<DebitRow> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        select: { id: true, status: true, sequenceNo: true },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');

      // FR-037b. Applying to an issued bill would either move a figure FR-044 froze or record a
      // recovery the bill never made — and both of those are wrong in a way nobody would notice
      // until a subcontractor asked why their payment was short.
      if (pkg.status !== BillPackageStatus.draft) {
        throw new ConflictException({
          statusCode: 409,
          code: PACKAGE_ERRORS.packageIssued,
          message:
            `${packageLabel(
              pkg.sequenceNo,
            )} has been issued, so a debit cannot be applied to it. ` +
            'Apply it to the next bill instead — a recovery added after issue is either a change ' +
            'to a signed document or a figure the bill never actually recovered.',
        });
      }

      const claimed = await tx.billPackageDebit.updateMany({
        where: { id: debitId, recoveredOnPackageId: null },
        data: { recoveredOnPackageId: packageId },
      });

      if (claimed.count === 0) {
        const existing = await tx.billPackageDebit.findFirst({
          where: { id: debitId },
          select: {
            recoveredOnPackageId: true,
            recoveredOnPackage: { select: { sequenceNo: true } },
          },
        });
        if (!existing) throw new NotFoundException('Debit not found');
        throw new ConflictException({
          statusCode: 409,
          code: PACKAGE_ERRORS.debitAlreadyRecovered,
          message:
            'This debit has already been recovered on ' +
            `${
              existing.recoveredOnPackage
                ? packageLabel(existing.recoveredOnPackage.sequenceNo)
                : 'another bill'
            }. A debit recovered twice is money taken twice.`,
          recoveredOnPackageId: existing.recoveredOnPackageId,
        });
      }

      const row = await tx.billPackageDebit.findFirstOrThrow({
        where: { id: debitId },
      });
      return toRow(row);
    });
  }

  /**
   * The register as one package shows it (FR-039, FR-039a, FR-040).
   *
   * Live for a draft; as at issue for an issued package. See this class's docblock for why those
   * are different registers and why a single live one cannot be right.
   */
  async registerFor(
    ctx: RlsContext,
    packageId: string,
  ): Promise<DebitRegister> {
    return withRlsContext(this.prisma, ctx, async (tx) => {
      const pkg = await tx.billPackage.findFirst({
        where: { id: packageId },
        select: {
          id: true,
          projectId: true,
          status: true,
          issuedAt: true,
        },
      });
      if (!pkg) throw new NotFoundException('Bill package not found');

      const asAtIssue =
        pkg.status !== BillPackageStatus.draft && !!pkg.issuedAt;

      const debits = await tx.billPackageDebit.findMany({
        where: {
          projectId: pkg.projectId,
          ...(asAtIssue ? { recordedAt: { lte: pkg.issuedAt as Date } } : {}),
        },
        include: { recoveredOnPackage: { select: { sequenceNo: true } } },
        orderBy: [{ groupHeading: 'asc' }, { recordedAt: 'asc' }],
      });

      const groups: { heading: string | null; rows: DebitRow[] }[] = [];
      for (const debit of debits) {
        const row = toRow(debit);
        const last = groups[groups.length - 1];
        if (last && last.heading === debit.groupHeading) {
          last.rows.push(row);
        } else {
          groups.push({ heading: debit.groupHeading, rows: [row] });
        }
      }

      const recovered = debits
        .filter((debit) => debit.recoveredOnPackageId === packageId)
        .reduce((total, debit) => total.plus(debit.amountWithTax), ZERO);
      const total = debits.reduce(
        (sum, debit) => sum.plus(debit.amountWithTax),
        ZERO,
      );

      return {
        packageId: pkg.id,
        asAtIssue,
        groups,
        recoveredOnThisPackage: recovered.toFixed(2),
        total: total.toFixed(2),
      };
    });
  }
}

type DebitEntity = {
  id: string;
  groupHeading: string | null;
  description: string;
  location: string | null;
  nos: Prisma.Decimal | null;
  length: Prisma.Decimal | null;
  width: Prisma.Decimal | null;
  quantity: Prisma.Decimal | null;
  unit: string | null;
  rate: Prisma.Decimal;
  amount: Prisma.Decimal;
  amountWithTax: Prisma.Decimal;
  recoveredOnPackageId: string | null;
  recoveredOnPackage?: { sequenceNo: number } | null;
  recordedAt: Date;
};

function toRow(debit: DebitEntity): DebitRow {
  return {
    id: debit.id,
    groupHeading: debit.groupHeading,
    description: debit.description,
    location: debit.location,
    nos: debit.nos?.toFixed(3) ?? null,
    length: debit.length?.toFixed(3) ?? null,
    width: debit.width?.toFixed(3) ?? null,
    quantity: debit.quantity?.toFixed(3) ?? null,
    unit: debit.unit,
    rate: debit.rate.toFixed(2),
    amount: debit.amount.toFixed(2),
    amountWithTax: debit.amountWithTax.toFixed(2),
    recoveredOn: debit.recoveredOnPackage
      ? packageLabel(debit.recoveredOnPackage.sequenceNo)
      : null,
    recoveredOnPackageId: debit.recoveredOnPackageId,
    recordedAt: debit.recordedAt.toISOString(),
  };
}
