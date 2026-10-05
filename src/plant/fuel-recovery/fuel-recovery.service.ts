import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  FuelAttribution,
  FuelExceptionStatus,
  HireBillStatus,
  OperatorRecoveryStatus,
  Permission,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { ApprovalService } from '../../approvals/approvals.service';
import { ACTION_OPERATOR_FUEL_RECOVERY } from '../../approvals/default-chains';
import { OnEvent } from '@nestjs/event-emitter';
import {
  APPROVAL_COMPLETED_EVENT,
  APPROVAL_REJECTED_EVENT,
  ApprovalRejectedEvent,
  type ApprovalCompletedEvent,
} from '../../approvals/approvals.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { AuditLogService } from '../../auth/audit-log.service';
import { companyScope } from '../../settings/company-scope';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { computeFuelShortfall } from '../fuel/fuel.service';
import { PlantRefsService } from '../plant-refs.service';
import { computeHireBillAmounts } from '../hire-bills/hire-bills.service';
import { webRoutes } from '../../common/web-routes';

/**
 * Recovering a confirmed fuel loss — from the hire bill, or from the operator (020 FR-003 to FR-007,
 * FR-010). Phase 6: where a figure first moves.
 *
 * ## Two destinations, never both
 *
 * FR-002's attribution is **exclusive**, and this service enforces it in three places that each catch
 * a different mistake. The `@@unique([fuelVarianceExceptionId])` on both tables makes double recovery
 * from one destination structurally impossible. The attribution check below refuses the wrong
 * destination for the attribution recorded. And the cross-check refuses a second destination even when
 * the attribution says `both` — because "both bear it" means the loss is shared, not doubled.
 *
 * ## Approval sits between raising and applying
 *
 * FR-006: an operator recovery reaches no payroll line until it is approved. That is a **spine gate**
 * and not a check inside the payroll engine — the engine reads only `approved` recoveries, so there is
 * no code path that applies an unapproved one, rather than a condition somebody could forget.
 *
 * ## Where application actually happens, and why it is not here
 *
 * T060 reads "apply on `approval.completed`". The handler below marks the recovery **approved**; the
 * payroll engine applies it on the next run. Applying it from the handler would mean writing into a
 * payroll line for a period that may have no run yet, or has one already approved or paid — rewriting
 * a figure somebody has transferred against. The advance-recovery machinery this follows works the
 * same way for the same reason, and `appliedPayrollLineItemId` is what records the hand-off.
 */
@Injectable()
export class FuelRecoveryService {
  private readonly logger = new Logger(FuelRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: PlantRefsService,
    private readonly approvals: ApprovalService,
  ) {}

  /**
   * The recoverable shortfall for a confirmed exception, in litres and money (FR-001).
   *
   * One definition, shared by both destinations. If the hire bill and the operator computed this
   * separately they would disagree the first time either changed, and the figure is money.
   */
  private async shortfallFor(caller: AuthenticatedUser, id: string) {
    const exception = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.fuelVarianceException.findFirst({
          where: { id, ...companyScope(caller) },
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
            hireBillDeduction: { select: { id: true } },
            operatorRecovery: { select: { id: true, status: true } },
          },
        }),
    );
    if (!exception) throw new NotFoundException('Fuel exception not found');

    if (exception.status !== FuelExceptionStatus.confirmed) {
      throw new BadRequestException({
        code: 'FUEL_RECOVERY_NOT_CONFIRMED',
        message:
          'Only a confirmed exception can be recovered. Review it first.',
      });
    }

    // The logbook is where consumption and hours live; the fuel entry carries what the fuel cost.
    // Matched on equipment and date, which `@@unique([equipmentId, date])` makes a single row.
    const logbook = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.logbookEntry.findUnique({
          where: {
            equipmentId_date: {
              equipmentId: exception.fuelEntry.equipmentId,
              date: exception.fuelEntry.date,
            },
          },
          select: { fuelConsumed: true, totalHours: true },
        }),
    );

    const categories = await this.refs.categoriesByIds(caller, [
      exception.fuelEntry.equipment.categoryId,
    ]);
    const benchmark =
      categories.get(exception.fuelEntry.equipment.categoryId)?.fuelBenchmark ??
      null;

    const shortfall = computeFuelShortfall({
      // The same fallback the detector uses: where the logbook recorded no consumption, the entry's
      // issued quantity stands in. Diverging here would mean recovering against a figure that is not
      // the one that raised the alert.
      fuelConsumed:
        logbook?.fuelConsumed !== null && logbook?.fuelConsumed !== undefined
          ? Number(logbook.fuelConsumed)
          : logbook
          ? Number(exception.fuelEntry.quantity)
          : null,
      totalHours: logbook ? Number(logbook.totalHours) : null,
      benchmark: benchmark === null ? null : Number(benchmark),
      rate: Number(exception.fuelEntry.rate),
    });

    if (shortfall.shortfallAmount <= 0) {
      throw new BadRequestException({
        code: 'FUEL_RECOVERY_NOTHING_TO_RECOVER',
        message:
          'This reading is at or under its benchmark now, so there is nothing to recover. ' +
          'A benchmark changed since it was flagged.',
      });
    }

    return { exception, shortfall };
  }

  /**
   * FR-002's exclusivity, checked before either destination writes.
   *
   * `both` is the case worth spelling out: it means the hirer and the operator **share** the loss,
   * not that the same rupees are collected twice. So the first recovery raised under `both` claims the
   * exception and the second is refused — the same rule as a single attribution, reached differently.
   */
  private assertNoOtherRecovery(
    exception: {
      attribution: FuelAttribution | null;
      hireBillDeduction: { id: string } | null;
      operatorRecovery: { id: string; status: OperatorRecoveryStatus } | null;
    },
    raising: 'hire_bill' | 'operator',
  ): void {
    // `reversed` **and `rejected`** are both dead. The second was missing until 2026-10-04 and it
    // is the more important of the two: a recovery the Director refused is precisely the case where
    // somebody wants to attribute the loss to the hirer instead, and treating it as live made that
    // impossible — while saying the loss was "already being recovered from the other party", which
    // was the opposite of what had happened.
    const DEAD: OperatorRecoveryStatus[] = [
      OperatorRecoveryStatus.reversed,
      OperatorRecoveryStatus.rejected,
    ];
    const other =
      raising === 'hire_bill'
        ? exception.operatorRecovery &&
          !DEAD.includes(exception.operatorRecovery.status)
        : exception.hireBillDeduction;
    if (other) {
      throw new BadRequestException({
        code: 'FUEL_RECOVERY_ALREADY_RECOVERED',
        message:
          'This loss is already being recovered from the other party. One loss, one recovery.',
      });
    }

    const permitted: FuelAttribution[] =
      raising === 'hire_bill'
        ? [FuelAttribution.hirer, FuelAttribution.both]
        : [FuelAttribution.operator, FuelAttribution.both];
    if (
      exception.attribution === null ||
      !permitted.includes(exception.attribution)
    ) {
      throw new BadRequestException({
        code: 'FUEL_RECOVERY_WRONG_ATTRIBUTION',
        message:
          raising === 'hire_bill'
            ? 'This exception is not attributed to the hirer.'
            : 'This exception is not attributed to the operator.',
      });
    }
  }

  /**
   * Deducts a confirmed loss from the equipment's hire bill (FR-003, FR-004).
   *
   * No approval chain: a hire bill is a document the company is still assembling, and a deduction on
   * it is an adjustment before payment rather than money leaving. The operator recovery is gated
   * because it takes from a person's wages; this takes from an invoice the vendor has not been paid.
   */
  async deductFromHireBill(
    caller: AuthenticatedUser,
    exceptionId: string,
    ipAddress: string,
  ) {
    const { exception, shortfall } = await this.shortfallFor(
      caller,
      exceptionId,
    );
    this.assertNoOtherRecovery(exception, 'hire_bill');

    // FR-003's "against a hire bill" needs one, and the bill is found rather than named: a caller
    // choosing the bill could point the deduction at a period the fuel was not burned in.
    const bill = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.hireBill.findFirst({
          where: {
            ...companyScope(caller),
            equipmentId: exception.fuelEntry.equipmentId,
            billingPeriodFrom: { lte: exception.fuelEntry.date },
            billingPeriodTo: { gte: exception.fuelEntry.date },
          },
          orderBy: [{ createdAt: 'desc' }],
        }),
    );

    /**
     * FR-055-style ordering decision, stated because the task asked for the carry: a **paid** bill
     * is never adjusted, and the recovery moves to the next unpaid bill for the same equipment and
     * vendor.
     *
     * Adjusting a paid bill changes a figure somebody has already transferred against — the ledger
     * and the bank would disagree, and the bill is the document the transfer was justified by. The
     * carry is what keeps the money recoverable without rewriting history.
     */
    const target =
      bill && bill.status !== HireBillStatus.paid
        ? bill
        : bill
        ? await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
            tx.hireBill.findFirst({
              where: {
                ...companyScope(caller),
                equipmentId: bill.equipmentId,
                vendorId: bill.vendorId,
                status: { not: HireBillStatus.paid },
                billingPeriodFrom: { gt: bill.billingPeriodFrom },
              },
              orderBy: [{ billingPeriodFrom: 'asc' }],
            }),
          )
        : null;

    if (!target) {
      throw new BadRequestException({
        code: bill
          ? 'FUEL_RECOVERY_NO_UNPAID_BILL'
          : 'FUEL_RECOVERY_NO_HIRE_BILL',
        message: bill
          ? 'That period’s hire bill is already paid and there is no later unpaid bill to carry ' +
            'this to. Raise the next bill first.'
          : 'No hire bill covers the date this fuel was issued.',
      });
    }

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const deduction = await tx.hireBillDeduction.create({
          data: {
            companyId: target.companyId,
            hireBillId: target.id,
            fuelVarianceExceptionId: exception.id,
            amount: new Prisma.Decimal(shortfall.shortfallAmount),
            createdByUserId: caller.id,
          },
        });
        await this.recomputeNetPayable(tx, target.id);
        return deduction;
      },
    );

    await this.auditLog.record({
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.FUEL_VARIANCE_EXCEPTION,
      entityId: exception.id,
      accountId: caller.id,
      companyId: target.companyId,
      ipAddress,
      changes: {
        recoveredFrom: 'hire_bill',
        hireBillId: target.id,
        amount: shortfall.shortfallAmount,
        carried: target.id !== bill?.id,
      },
    });

    return { deduction: created, hireBillId: target.id, shortfall };
  }

  /**
   * Recomputes a hire bill's `netPayable` from its components and its current deductions (FR-004,
   * T054).
   *
   * **Recomputed, never decremented.** A net reduced by an `UPDATE` is a figure with no derivation,
   * and a vendor disputing the bill is owed the arithmetic. Recomputing also makes reversal free:
   * FR-010 deletes the deduction row and calls this again, where an in-place decrement would need an
   * inverse adjustment — a second entry explaining the first.
   *
   * Takes the transaction client rather than opening its own, so the deduction and the net it implies
   * cannot be separated by a failure.
   */
  private async recomputeNetPayable(
    tx: Prisma.TransactionClient,
    hireBillId: string,
  ): Promise<void> {
    const bill = await tx.hireBill.findUniqueOrThrow({
      where: { id: hireBillId },
      include: { fuelDeductions: { select: { amount: true } } },
    });

    const { netPayable } = computeHireBillAmounts({
      billedHours: Number(bill.billedHours),
      rate: Number(bill.rate),
      tdsRate: bill.tdsRate === null ? null : Number(bill.tdsRate),
      deductions: bill.fuelDeductions.map((row) => Number(row.amount)),
    });

    await tx.hireBill.update({
      where: { id: hireBillId },
      data: { netPayable: new Prisma.Decimal(netPayable) },
    });
  }

  /**
   * Raises a recovery against the operator's salary and submits it for approval (FR-005, FR-006).
   *
   * The row is created `pending_approval` and the payroll engine reads only `approved` rows, so
   * **there is no code path that applies an unapproved recovery** — FR-006 is a property of the
   * query rather than a check somebody could omit.
   */
  async raiseOperatorRecovery(
    caller: AuthenticatedUser,
    exceptionId: string,
    ipAddress: string,
  ) {
    const { exception, shortfall } = await this.shortfallFor(
      caller,
      exceptionId,
    );
    this.assertNoOtherRecovery(exception, 'operator');

    if (!exception.operatorEmployeeId) {
      throw new BadRequestException({
        code: 'FUEL_RECOVERY_OPERATOR_UNKNOWN',
        message:
          'No operator is named on this exception. Name one when confirming it.',
      });
    }

    const recovery = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.operatorFuelRecovery.create({
          data: {
            companyId: exception.companyId,
            fuelVarianceExceptionId: exception.id,
            employeeId: exception.operatorEmployeeId as string,
            amount: new Prisma.Decimal(shortfall.shortfallAmount),
            createdByUserId: caller.id,
          },
        }),
    );

    // Submitted after the row exists, the reverse of the attendance correction's order, because here
    // the id is the database's. A failure between the two leaves a recovery that is
    // `pending_approval` with no `approvalItemId` — visible, inert, and recoverable by resubmitting.
    // The other order would leave an approvable item with nothing behind it.
    const instance = await this.approvals.submit({
      companyId: exception.companyId,
      actionType: ACTION_OPERATOR_FUEL_RECOVERY,
      entityType: ACTION_OPERATOR_FUEL_RECOVERY,
      entityId: recovery.id,
      originatorUserId: caller.id,
      subject: `${exception.fuelEntry.equipment.code} — fuel recovery of ${shortfall.shortfallAmount} from operator`,
      href: webRoutes.plantFuel(),
      viewPermission: Permission.MACHINERY,
    });

    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.operatorFuelRecovery.update({
        where: { id: recovery.id },
        data: { approvalItemId: instance.instanceId },
      }),
    );

    await this.auditLog.record({
      action: AuditAction.CREATE,
      entityType: AuditEntityType.FUEL_VARIANCE_EXCEPTION,
      entityId: exception.id,
      accountId: caller.id,
      companyId: exception.companyId,
      ipAddress,
      changes: {
        recoveredFrom: 'operator',
        employeeId: exception.operatorEmployeeId,
        amount: shortfall.shortfallAmount,
        approvalInstanceId: instance.instanceId,
      },
    });

    return {
      recoveryId: recovery.id,
      approvalInstanceId: instance.instanceId,
      state: instance.state,
      shortfall,
    };
  }

  /**
   * Marks an approved recovery eligible for payroll (FR-006, T060).
   *
   * **Idempotent**, because the event is redelivered: the bus offers no once-only guarantee and a
   * decision can reach completion by more than one path. The status is the guard — a row already past
   * `pending_approval` is left alone, so a second delivery changes nothing.
   *
   * It does **not** write a payroll line. See the class comment: the period may have no run yet, or
   * one already approved or paid, and rewriting that is worse than waiting for the next run.
   */
  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_OPERATOR_FUEL_RECOVERY) return;

    try {
      await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
        tx.operatorFuelRecovery.updateMany({
          where: {
            id: event.entityId,
            status: OperatorRecoveryStatus.pending_approval,
          },
          data: { status: OperatorRecoveryStatus.approved },
        }),
      );
    } catch (error) {
      // Logged, never thrown: an event handler that throws takes down the delivery for every other
      // listener on the same event, and the recovery is recoverable by hand where this fails.
      this.logger.error(
        `Could not mark fuel recovery ${event.entityId} approved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Marks a refused recovery `rejected`, so it stops claiming to be waiting (FR-006).
   *
   * **Added 2026-10-04, and `OperatorRecoveryStatus.rejected` was set by nothing before it.** The
   * value existed in the schema; the spine emitted no event on rejection; so a recovery the
   * Director refused sat at `pending_approval` for ever. Two costs, and the second is the one that
   * mattered:
   *
   *   * a reviewer could not tell a refused recovery from one still waiting; and
   *   * `assertNoOtherRecovery` treats any operator recovery that is not `reversed` as live, so the
   *     refused one **blocked recovering the same loss from the hirer instead** — refusing with
   *     *"This loss is already being recovered from the other party"*, which was false. After a
   *     Director said "do not dock the operator", the fuel could be recovered from nobody.
   *
   * Found by writing 020 T065, which asserted a status that never arrived.
   *
   * Idempotent on the same terms as the completion handler: the status is the guard, so a
   * redelivered event changes nothing. Scoped to `pending_approval` so a rejection arriving after
   * a reversal cannot undo it.
   */
  @OnEvent(APPROVAL_REJECTED_EVENT)
  async onApprovalRejected(event: ApprovalRejectedEvent): Promise<void> {
    if (event.entityType !== ACTION_OPERATOR_FUEL_RECOVERY) return;

    try {
      await withRlsContext(this.prisma, { isSuperAdmin: true }, (tx) =>
        tx.operatorFuelRecovery.updateMany({
          where: {
            id: event.entityId,
            status: OperatorRecoveryStatus.pending_approval,
          },
          data: { status: OperatorRecoveryStatus.rejected },
        }),
      );
    } catch (error) {
      // Logged, never thrown — same reason as the completion handler: a throw here takes down
      // delivery for every other listener on the event.
      this.logger.error(
        `Could not mark fuel recovery ${event.entityId} rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Reverses a recovery after the reading behind it is corrected (FR-010).
   *
   * A hire-bill deduction is **deleted** and the net recomputed; an operator recovery is **marked**
   * reversed and kept. The asymmetry is deliberate: a deduction on an unpaid bill never left the
   * company, so removing it leaves nothing to explain, while a recovery may already have reduced
   * somebody's pay — and a row deleted from under a payslip makes that payslip unexplainable.
   */
  async reverse(
    caller: AuthenticatedUser,
    exceptionId: string,
    ipAddress: string,
  ) {
    const exception = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.fuelVarianceException.findFirst({
          where: { id: exceptionId, ...companyScope(caller) },
          include: {
            hireBillDeduction: true,
            operatorRecovery: true,
          },
        }),
    );
    if (!exception) throw new NotFoundException('Fuel exception not found');

    if (exception.hireBillDeduction) {
      const hireBillId = exception.hireBillDeduction.hireBillId;
      await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
        const bill = await tx.hireBill.findUniqueOrThrow({
          where: { id: hireBillId },
          select: { status: true },
        });
        if (bill.status === HireBillStatus.paid) {
          throw new BadRequestException({
            code: 'FUEL_RECOVERY_BILL_PAID',
            message:
              'That bill has been paid. Reversing the deduction now would change a figure already ' +
              'transferred against.',
          });
        }
        await tx.hireBillDeduction.delete({
          where: { id: exception.hireBillDeduction!.id },
        });
        await this.recomputeNetPayable(tx, hireBillId);
      });
    } else if (exception.operatorRecovery) {
      if (
        exception.operatorRecovery.status === OperatorRecoveryStatus.reversed
      ) {
        throw new BadRequestException({
          code: 'FUEL_RECOVERY_ALREADY_REVERSED',
          message: 'This recovery has already been reversed.',
        });
      }
      await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
        tx.operatorFuelRecovery.update({
          where: { id: exception.operatorRecovery!.id },
          data: {
            status: OperatorRecoveryStatus.reversed,
            reversedAt: new Date(),
            reversedByUserId: caller.id,
          },
        }),
      );
    } else {
      throw new BadRequestException({
        code: 'FUEL_RECOVERY_NOTHING_TO_REVERSE',
        message: 'Nothing has been recovered against this exception.',
      });
    }

    await this.auditLog.record({
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.FUEL_VARIANCE_EXCEPTION,
      entityId: exception.id,
      accountId: caller.id,
      companyId: exception.companyId,
      ipAddress,
      changes: { reversed: true },
    });

    return { reversed: true };
  }

  // ───────────────────────────────────────────────────────────────────────────────
  // The payroll boundary (FR-006, FR-007, FR-007b)
  //
  // `payroll` must not query `plant`'s schema (Principle I), so these two methods are the whole
  // interface between them: one reads what is owed, the other records what was taken. Keeping it to
  // two methods is also what makes FR-006 checkable — there is exactly one query that can surface a
  // recovery to payroll, and its `where` clause is the gate.
  // ───────────────────────────────────────────────────────────────────────────────

  /**
   * What each of these employees owes in fuel recovery (FR-006).
   *
   * **Only `approved` rows, and only unsettled balances.** A `pending_approval` row is invisible here,
   * which is how FR-006's "no payroll line until approved" is a property of the query rather than a
   * condition in the engine. A `reversed` row is invisible for the same reason — reversal must stop
   * future instalments, not merely record an intention.
   *
   * Oldest first: a balance that has been carrying for months is settled before one raised last week,
   * so a long-carried balance cannot be starved by newer ones (FR-007c).
   */
  async dueForEmployees(
    companyId: string,
    employeeIds: readonly string[],
  ): Promise<Map<string, { recoveryId: string; balance: number }[]>> {
    if (employeeIds.length === 0) return new Map();

    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId },
      (tx) =>
        tx.operatorFuelRecovery.findMany({
          where: {
            companyId,
            employeeId: { in: [...employeeIds] },
            status: OperatorRecoveryStatus.approved,
          },
          orderBy: [{ createdAt: 'asc' }],
          select: {
            id: true,
            employeeId: true,
            amount: true,
            recoveredAmount: true,
          },
        }),
    );

    const due = new Map<string, { recoveryId: string; balance: number }[]>();
    for (const row of rows) {
      const balance =
        Math.round((Number(row.amount) - Number(row.recoveredAmount)) * 100) /
        100;
      // A row whose balance has reached zero but whose status has not caught up — possible if a
      // write failed between the two. Skipped rather than trusted, so a settled recovery cannot be
      // collected twice.
      if (balance <= 0) continue;
      const list = due.get(row.employeeId) ?? [];
      list.push({ recoveryId: row.id, balance });
      due.set(row.employeeId, list);
    }
    return due;
  }

  /**
   * Records what a payroll line actually took (FR-007b).
   *
   * Takes the caller's transaction client, the same shape `SalaryAdvancesService.applyRecovery` uses,
   * so the balance reduction and the deduction that caused it are written together or not at all. A
   * separate transaction here would allow a payslip showing a recovery against a balance that was
   * never reduced.
   *
   * Increments rather than sets, because a carried recovery is collected over several periods and each
   * instalment adds to what has been taken. `applied` is reached only when the balance clears — until
   * then the row stays `approved` and keeps appearing in `dueForEmployees`, which is what makes the
   * carry happen rather than being something the engine has to remember.
   */
  async recordRecovered(
    tx: Prisma.TransactionClient,
    recoveryId: string,
    amount: number,
    payrollLineItemId: string,
  ): Promise<void> {
    const row = await tx.operatorFuelRecovery.findUniqueOrThrow({
      where: { id: recoveryId },
      select: { amount: true, recoveredAmount: true },
    });
    const recovered =
      Math.round((Number(row.recoveredAmount) + amount) * 100) / 100;
    const settled = recovered >= Number(row.amount);

    await tx.operatorFuelRecovery.update({
      where: { id: recoveryId },
      data: {
        recoveredAmount: new Prisma.Decimal(recovered),
        appliedPayrollLineItemId: payrollLineItemId,
        ...(settled ? { status: OperatorRecoveryStatus.applied } : {}),
      },
    });
  }
}
