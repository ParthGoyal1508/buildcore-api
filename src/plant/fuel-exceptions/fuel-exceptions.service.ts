import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  FuelAttribution,
  FuelExceptionStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { AuditLogService } from '../../auth/audit-log.service';
import { companyScope } from '../../settings/company-scope';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { computeFuelShortfall } from '../fuel/fuel.service';
import { PlantRefsService } from '../plant-refs.service';
import { ReviewFuelExceptionDto } from './dto/fuel-exception.dto';

/**
 * Turning a fuel alert into a decision somebody's name is against (020 FR-001, FR-002, FR-008,
 * FR-009) — `bugs.md` item 13.
 *
 * ## Detection is not touched here
 *
 * FR-017. `Equipment.fuelBenchmark`, `FuelEntry.variancePercent` and `FuelEntry.varianceAlert` keep
 * computing exactly as they did, and nothing in this service writes any of them. Raising an
 * exception is deliberately **not** done inside the detector: coupling the two would mean a change
 * to either could silently alter the other, and the alert is the evidence the review rests on.
 *
 * ## This phase moves no money
 *
 * Confirming an exception records who bears it. Actually recovering it — from a hire bill or from an
 * operator's salary — is Phase 6, and is a separate act with its own approval. Keeping them apart is
 * what lets a reviewer work through a list without each click costing somebody money.
 */
@Injectable()
export class FuelExceptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: PlantRefsService,
  ) {}

  /**
   * Raises an `open` exception for every alerted reading that has none yet.
   *
   * A sweep rather than a hook inside the detector (FR-017), and idempotent by the unique index on
   * `fuelEntryId`: running it twice raises nothing the second time. `skipDuplicates` rather than a
   * read-then-write, so two concurrent sweeps cannot both decide a row is missing.
   */
  async raiseOutstanding(caller: AuthenticatedUser): Promise<number> {
    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const alerted = await tx.fuelEntry.findMany({
        where: {
          ...companyScope(caller),
          varianceAlert: true,
          varianceException: { is: null },
        },
        select: { id: true, companyId: true },
      });
      if (alerted.length === 0) return 0;

      const created = await tx.fuelVarianceException.createMany({
        data: alerted.map((entry) => ({
          companyId: entry.companyId,
          fuelEntryId: entry.id,
        })),
        skipDuplicates: true,
      });
      return created.count;
    });
  }

  /**
   * The review list (FR-001): each breaching machine with its actual, its benchmark and the
   * variance between them.
   *
   * The equipment's benchmark is read live while the entry's `variancePercent` is the stored value
   * from save time. That asymmetry is deliberate and worth seeing on screen: a benchmark edited
   * since the reading explains why a figure that looks fine today was flagged then.
   */
  async list(caller: AuthenticatedUser, status?: FuelExceptionStatus) {
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.fuelVarianceException.findMany({
          where: {
            ...companyScope(caller),
            ...(status ? { status } : {}),
          },
          orderBy: [{ createdAt: 'desc' }],
          include: {
            fuelEntry: {
              include: {
                equipment: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    ownership: true,
                    categoryId: true,
                  },
                },
              },
            },
          },
        }),
    );

    // The benchmark lives on the **category**, in `settings`, so it is resolved through
    // `PlantRefsService` rather than joined — `plant` does not query another schema (Principle I).
    // Batched once for the whole page: a per-row lookup would be one round trip per exception.
    const categories = await this.refs.categoriesByIds(caller, [
      ...new Set(rows.map((row) => row.fuelEntry.equipment.categoryId)),
    ]);

    // FR-001 asks for the shortfall in litres and rupees, and neither can be derived from anything
    // on the fuel entry: the excess is measured against what the benchmark allowed for the hours
    // actually run, and the hours live in the logbook. Read here, in one query for the page, so the
    // interface is not left to compute it from `variancePercent` — which is rounded to two decimals
    // at save time, and would give a figure the readings behind it cannot reproduce.
    const readings = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.logbookEntry.findMany({
          where: {
            OR: rows.map((row) => ({
              equipmentId: row.fuelEntry.equipmentId,
              date: row.fuelEntry.date,
            })),
          },
          select: {
            equipmentId: true,
            date: true,
            fuelConsumed: true,
            totalHours: true,
          },
        }),
    );
    const readingKey = (equipmentId: string, date: Date) =>
      `${equipmentId}|${date.toISOString().slice(0, 10)}`;
    const readingBy = new Map(
      readings.map((reading) => [
        readingKey(reading.equipmentId, reading.date),
        reading,
      ]),
    );

    return rows.map((row) => {
      const benchmark =
        categories.get(row.fuelEntry.equipment.categoryId)?.fuelBenchmark ??
        null;
      const reading = readingBy.get(
        readingKey(row.fuelEntry.equipmentId, row.fuelEntry.date),
      );
      const fuelConsumed =
        reading?.fuelConsumed === null || reading?.fuelConsumed === undefined
          ? null
          : Number(reading.fuelConsumed);
      const totalHours =
        reading?.totalHours === null || reading?.totalHours === undefined
          ? null
          : Number(reading.totalHours);

      return {
        ...row,
        // FR-001 wants the actual, the benchmark and the gap between them on one line. The entry's
        // `variancePercent` is the figure computed at save time and the benchmark is read now, which
        // is worth seeing together: a benchmark edited since explains why a reading that looks fine
        // today was flagged then.
        benchmark,
        /**
         * Litres per meter unit actually burned, against the benchmark above.
         *
         * Null where the logbook has no reading for that day — which is a real state, not a
         * failure: the fuel was issued and the machine's hours were never entered. A screen showing
         * zero there would read as a machine that ran for no hours and still burned fuel.
         */
        actualPerHour:
          fuelConsumed !== null && totalHours !== null && totalHours > 0
            ? Math.round((fuelConsumed / totalHours) * 1000) / 1000
            : null,
        // The same function the recovery uses, so the figure a reviewer reads before deciding is
        // the figure that reaches the hire bill or the payslip. Two implementations of this would
        // disagree in the fourth decimal and be argued about in rupees.
        ...computeFuelShortfall({
          fuelConsumed,
          totalHours,
          benchmark,
          rate: Number(row.fuelEntry.rate),
        }),
      };
    });
  }

  /**
   * Confirm with an attribution, or dismiss with a reason (FR-002, FR-008, FR-009).
   *
   * Every refusal below carries a machine-readable code, because each one is a thing the interface
   * has to say differently — "name who bears this" and "say why you are dismissing it" are not the
   * same instruction.
   */
  async review(
    caller: AuthenticatedUser,
    id: string,
    dto: ReviewFuelExceptionDto,
    ipAddress: string,
  ) {
    const existing = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.fuelVarianceException.findFirst({
          where: { id, ...companyScope(caller) },
          include: {
            fuelEntry: {
              select: {
                equipmentId: true,
                date: true,
                equipment: { select: { ownership: true } },
              },
            },
          },
        }),
    );
    if (!existing) throw new NotFoundException('Fuel exception not found');
    if (existing.status !== FuelExceptionStatus.open) {
      throw new BadRequestException({
        code: 'FUEL_EXCEPTION_ALREADY_REVIEWED',
        message: 'This exception has already been reviewed.',
      });
    }

    if (dto.status === FuelExceptionStatus.dismissed) {
      // FR-008. A dismissal nobody has to justify is how an exception register becomes a list
      // everybody clears without reading.
      if (!dto.reason?.trim()) {
        throw new BadRequestException({
          code: 'FUEL_EXCEPTION_REASON_REQUIRED',
          message: 'Say why this exception is not being pursued.',
        });
      }
      return this.write(caller, id, ipAddress, {
        status: FuelExceptionStatus.dismissed,
        reason: dto.reason.trim(),
      });
    }

    // --- Confirming. ---

    // FR-002. No default attribution anywhere in this feature: a default would decide, quietly and
    // at scale, who pays for fuel nobody can account for.
    if (!dto.attribution) {
      throw new BadRequestException({
        code: 'FUEL_EXCEPTION_ATTRIBUTION_REQUIRED',
        message: 'Name who bears this before confirming it.',
      });
    }

    // FR-004. There is no hirer to deduct from on a machine the company owns, and offering it would
    // invite a figure nobody can collect.
    if (
      dto.attribution === FuelAttribution.hirer &&
      existing.fuelEntry.equipment.ownership !== 'hired'
    ) {
      throw new BadRequestException({
        code: 'FUEL_EXCEPTION_NOT_HIRED',
        message:
          'This machine is owned, so there is no hire bill to deduct from.',
      });
    }

    let operatorEmployeeId: string | null = null;
    if (dto.attribution === FuelAttribution.operator) {
      operatorEmployeeId = await this.resolveOperator(caller, existing, dto);
    }

    return this.write(caller, id, ipAddress, {
      status: FuelExceptionStatus.confirmed,
      attribution: dto.attribution,
      operatorEmployeeId,
      reason: dto.reason?.trim() || null,
    });
  }

  /**
   * Which operator bears an operator-attributed exception (FR-009).
   *
   * **Never inferred when more than one person ran the machine.** Inferring is how the wrong
   * person's wages get docked, and the requirement says named explicitly. Where exactly one operator
   * appears in the logbook for that day the single candidate is adopted — there is nothing to choose
   * between, and forcing a reviewer to retype the only possible answer teaches them to click past
   * the question.
   */
  private async resolveOperator(
    caller: AuthenticatedUser,
    existing: {
      fuelEntry: { equipmentId: string; date: Date };
    },
    dto: ReviewFuelExceptionDto,
  ): Promise<string> {
    if (dto.operatorEmployeeId) return dto.operatorEmployeeId;

    const operators = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.logbookEntry.findMany({
          where: {
            equipmentId: existing.fuelEntry.equipmentId,
            date: existing.fuelEntry.date,
            operatorId: { not: null },
          },
          select: { operatorId: true },
          distinct: ['operatorId'],
        }),
    );

    const candidates = operators
      .map((row) => row.operatorId)
      .filter((operatorId): operatorId is string => !!operatorId);

    if (candidates.length === 1) return candidates[0];

    throw new BadRequestException({
      code: 'FUEL_EXCEPTION_OPERATOR_REQUIRED',
      message:
        candidates.length === 0
          ? 'No operator is recorded against this machine for that day. Name one.'
          : 'Several operators ran this machine that day. Name the one who bears this.',
      // The interface offers these rather than making somebody look them up elsewhere.
      candidates,
    });
  }

  private async write(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
    data: Prisma.FuelVarianceExceptionUncheckedUpdateInput,
  ) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.fuelVarianceException.update({
          where: { id },
          data: {
            ...data,
            reviewedByUserId: caller.id,
            reviewedAt: new Date(),
          },
        }),
    );

    await this.auditLog.record({
      entityType: AuditEntityType.FUEL_VARIANCE_EXCEPTION,
      action: AuditAction.UPDATE,
      entityId: updated.id,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
      changes: {
        status: updated.status,
        attribution: updated.attribution,
        operatorEmployeeId: updated.operatorEmployeeId,
      },
    });

    return updated;
  }
}
