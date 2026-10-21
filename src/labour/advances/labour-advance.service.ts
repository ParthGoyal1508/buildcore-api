import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  AdvanceStatus,
  ApprovalDecisionAction,
  AuditAction,
  AuditEntityType,
  Permission,
  Prisma,
  WorkerStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  APPROVAL_COMPLETED_EVENT,
  APPROVAL_REJECTED_EVENT,
  ApprovalService,
  type ApprovalCompletedEvent,
  type ApprovalRejectedEvent,
} from '../../approvals/approvals.service';
import { ACTION_LABOUR_ADVANCE } from '../../approvals/default-chains';
import { AuditLogService } from '../../auth/audit-log.service';
import { webRoutes } from '../../common/web-routes';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import {
  CashPolicyService,
  cashHiddenError,
} from '../../common/cash/cash-policy';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { SkillCategoriesService } from '../../settings/skill-categories/skill-categories.service';
import { LabourRefsService } from '../labour-refs.service';
import { SiteWageRateService } from '../site-rates/site-wage-rate.service';
import { zonedDateOnly } from '../../hr/leave/leave-days';
import { roundMoney } from '../payment-sheets/wage-calc.util';
import { parseDateOnly } from '../wage-rates/wage-rate.service';
import {
  MAX_ADVANCE_AMOUNT,
  MAX_RECOVERY_INSTALMENTS,
} from '../constants/labour.constants';
import {
  deductionEntries,
  restoreFor,
} from '../payment-sheets/payment-sheet.rules';

/**
 * Why an advance's amount or instalments cannot be accepted, or null. The DTO checks the same, but
 * the service is also called from places no DTO guards, and 2.5 instalments would price a fraction
 * of an instalment nobody can deduct (036 O12).
 */
export function advanceTermsProblem(
  amount: number,
  recoveryInstalments: number,
): string | null {
  if (!Number.isFinite(amount) || amount <= 0) {
    return 'The advance amount must be more than 0.';
  }
  if (amount > MAX_ADVANCE_AMOUNT) {
    return `The advance amount can be at most ${MAX_ADVANCE_AMOUNT}.`;
  }
  if (
    !Number.isInteger(recoveryInstalments) ||
    recoveryInstalments < 1 ||
    recoveryInstalments > MAX_RECOVERY_INSTALMENTS
  ) {
    return `Recovery instalments must be a whole number from 1 to ${MAX_RECOVERY_INSTALMENTS}.`;
  }
  return null;
}

export interface AdvanceView {
  id: string;
  workerId: string;
  amount: number;
  reason: string;
  recoveryInstalments: number;
  instalmentAmount: number;
  recoveryStartPeriod: string;
  outstandingBalance: number;
  exceedsLimit: boolean;
  status: AdvanceStatus;
  recoveryAtRisk: boolean;
  /** 036 O8: names alongside the ids, so the list need not show raw ids. Additive. */
  workerName: string | null;
  labourCode: string | null;
  createdBy: string | null;
  createdByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
}

type WorkerSummary = {
  id: string;
  status: WorkerStatus;
  fullName: string;
  labourCode: string;
};

@Injectable()
export class LabourAdvanceService {
  private readonly logger = new Logger(LabourAdvanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: LabourRefsService,
    private readonly skillCategories: SkillCategoriesService,
    private readonly siteRates: SiteWageRateService,
    private readonly approvals: ApprovalService,
    /** 038: hiding cash. Optional so unit tests can omit it (then nothing is hidden). */
    @Optional() private readonly cash?: CashPolicyService,
  ) {}

  /**
   * 038: an advance is always paid in cash at site, so while cash is hidden for its company no
   * advance is shown, raised, approved or disbursed.
   */
  private cashHidden(companyId: string | null | undefined): Promise<boolean> {
    return this.cash ? this.cash.isHidden(companyId) : Promise.resolve(false);
  }

  private async assertAdvancesAllowed(
    companyId: string | null | undefined,
  ): Promise<void> {
    if (await this.cashHidden(companyId)) throw cashHiddenError();
  }

  async findAll(
    caller: AuthenticatedUser,
    query: { companyId?: string; workerId?: string; status?: AdvanceStatus },
  ): Promise<AdvanceView[]> {
    let rows = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.labourAdvance.findMany({
        where: {
          ...companyScope(caller, query.companyId),
          deletedAt: null,
          ...(query.workerId ? { workerId: query.workerId } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    // 038: advances of a company hiding cash are not listed.
    const hidden = this.cash
      ? await this.cash.hiddenAmong(rows.map((r) => r.companyId))
      : new Set<string>();
    if (hidden.size > 0) {
      rows = rows.filter((r) => !hidden.has(r.companyId));
    }

    const workers = await this.workerSummaries(
      caller,
      rows.map((r) => r.workerId),
    );
    const people = await this.refs.userNames(
      rows.flatMap((r) => [r.createdBy, r.approvedBy]),
    );
    return rows.map((row) =>
      this.toView(row, workers.get(row.workerId), people),
    );
  }

  async findOne(caller: AuthenticatedUser, id: string) {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.labourAdvance.findUnique({ where: { id } }),
    );
    if (!row || row.deletedAt) {
      throw new NotFoundException(`Advance ${id} not found`);
    }
    assertInScope(caller, row, `Advance ${id}`);
    if (await this.cashHidden(row.companyId)) {
      throw new NotFoundException(`Advance ${id} not found`);
    }

    const workers = await this.workerSummaries(caller, [row.workerId]);
    const people = await this.refs.userNames([row.createdBy, row.approvedBy]);
    // Recovery history: disbursed sheet lines whose deductions recovered this advance.
    const disbursedLines = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.paymentSheetLine.findMany({
          where: { workerId: row.workerId, status: 'disbursed' },
          select: { id: true, sheetId: true, deductions: true, paidOn: true },
        }),
    );
    const recoveryHistory = disbursedLines.flatMap((line) =>
      deductionEntries(line.deductions)
        .filter((d) => d.type === 'advance' && d.advanceId === id)
        .map((d) => ({
          sheetId: line.sheetId,
          lineId: line.id,
          amount: d.amount,
          // 036 O1: what the disbursement actually took off the balance — less than `amount`
          // only where the balance was already lower.
          recovered: restoreFor(d),
          paidOn: line.paidOn ? line.paidOn.toISOString().slice(0, 10) : null,
        })),
    );

    return {
      ...this.toView(row, workers.get(row.workerId), people),
      recoveryHistory,
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      workerId: string;
      amount: number;
      reason: string;
      recoveryInstalments: number;
      recoveryStartPeriod: string;
    },
    ipAddress: string,
  ): Promise<AdvanceView> {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      throw new NotFoundException('Company not found');
    }
    await this.assertAdvancesAllowed(companyId);
    const termsProblem = advanceTermsProblem(
      dto.amount,
      dto.recoveryInstalments,
    );
    if (termsProblem) {
      throw new BadRequestException(termsProblem);
    }

    const dailyRate = await this.workerDailyRate(
      caller,
      dto.workerId,
      companyId,
    );
    const exceedsLimit =
      dailyRate !== null &&
      dto.amount > dailyRate * this.refs.advanceLimitMultiple;

    const instalmentAmount = roundMoney(dto.amount / dto.recoveryInstalments);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourAdvance.create({
          data: {
            companyId,
            workerId: dto.workerId,
            amount: dto.amount,
            reason: dto.reason,
            recoveryInstalments: dto.recoveryInstalments,
            instalmentAmount,
            recoveryStartPeriod: parseDateOnly(dto.recoveryStartPeriod),
            outstandingBalance: 0,
            exceedsLimit,
            status: AdvanceStatus.pending,
            createdBy: caller.id,
          },
        }),
    );

    // Into its approval chain (2026-10-20); undone if the company has none, rather than left
    // pending where nobody could ever approve it.
    try {
      await this.submitForApproval(caller, created, caller.id);
    } catch (error) {
      await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
        tx.labourAdvance.delete({ where: { id: created.id } }),
      );
      throw error;
    }

    await this.audit(
      AuditAction.CREATE,
      created.id,
      companyId,
      caller,
      ipAddress,
    );
    return this.viewOf(caller, created);
  }

  /**
   * Approves an advance — a decision on its approval chain (2026-10-20). It becomes approved, ready
   * to disburse, on the chain's final approval.
   */
  async approve(caller: AuthenticatedUser, id: string, ipAddress: string) {
    return this.decideOnChain(
      caller,
      id,
      ApprovalDecisionAction.approve,
      null,
      ipAddress,
    );
  }

  /** Rejects a pending advance (2026-10-20): it is never disbursed or recovered. */
  async reject(
    caller: AuthenticatedUser,
    id: string,
    reason: string,
    ipAddress: string,
  ) {
    if (!reason.trim()) {
      throw new BadRequestException(
        'A reason is required to reject an advance.',
      );
    }
    return this.decideOnChain(
      caller,
      id,
      ApprovalDecisionAction.reject,
      reason,
      ipAddress,
    );
  }

  private async decideOnChain(
    caller: AuthenticatedUser,
    id: string,
    action: ApprovalDecisionAction,
    reason: string | null,
    ipAddress: string,
  ) {
    const existing = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.labourAdvance.findUnique({ where: { id } }),
    );
    if (!existing || existing.deletedAt) {
      throw new NotFoundException(`Advance ${id} not found`);
    }
    assertInScope(caller, existing, `Advance ${id}`);
    await this.assertAdvancesAllowed(existing.companyId);
    if (existing.status !== AdvanceStatus.pending) {
      throw new ConflictException('Only a pending advance can be decided');
    }
    // Maker-checker (036 O12, decision 4): whoever raised the advance cannot decide it, with no
    // override — otherwise one person holding both permissions pays themselves a loan. Also refused
    // by the spine for advances raised since 2026-10-20.
    if (existing.createdBy && existing.createdBy === caller.id) {
      throw new ForbiddenException({
        code: 'SELF_APPROVAL',
        message:
          'You raised this advance, so you cannot decide it. Another approver must.',
      });
    }
    await this.ensureInChain(caller, existing);

    const view = await this.approvals.decideByEntity(
      ACTION_LABOUR_ADVANCE,
      id,
      { action, reason },
      caller,
      ipAddress,
    );
    if (view.state === 'approved' || view.state === 'rejected') {
      await this.applyOutcome(id, view.state, caller.id, ipAddress);
    }
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.labourAdvance.findUniqueOrThrow({ where: { id } }),
    );
    return this.viewOf(caller, updated);
  }

  /** The chain approved the advance at its last level (2026-10-20). */
  @OnEvent(APPROVAL_COMPLETED_EVENT)
  async onApprovalCompleted(event: ApprovalCompletedEvent): Promise<void> {
    if (event.entityType !== ACTION_LABOUR_ADVANCE) return;
    await this.onChainOutcome(event.entityId, event.companyId, 'approved');
  }

  /** The chain rejected it, at any level. */
  @OnEvent(APPROVAL_REJECTED_EVENT)
  async onApprovalRejected(event: ApprovalRejectedEvent): Promise<void> {
    if (event.entityType !== ACTION_LABOUR_ADVANCE) return;
    await this.onChainOutcome(event.entityId, event.companyId, 'rejected');
  }

  /** Logs rather than throws: the decision is already committed in the spine. */
  private async onChainOutcome(
    id: string,
    companyId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<void> {
    try {
      const state = await this.approvals.stateOfSystem(
        ACTION_LABOUR_ADVANCE,
        id,
        companyId,
      );
      await this.applyOutcome(
        id,
        outcome,
        state?.latestDecision?.actorUserId ?? null,
        '',
      );
    } catch (error) {
      this.logger.error(
        `Could not apply the ${outcome} chain outcome to labour advance ${id}`,
        error as Error,
      );
    }
  }

  /**
   * The final decision, written once: conditional on still pending, so the advances screen's own
   * decide and the spine's event — both of which arrive for a decision taken there — record it
   * once between them. A rejected advance keeps its zero balance and is never disbursed.
   */
  private async applyOutcome(
    id: string,
    outcome: 'approved' | 'rejected',
    deciderUserId: string | null,
    ipAddress: string,
  ): Promise<void> {
    const { moved, companyId } = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      async (tx) => {
        const result = await tx.labourAdvance.updateMany({
          where: { id, status: AdvanceStatus.pending },
          data:
            outcome === 'approved'
              ? {
                  status: AdvanceStatus.approved,
                  approvedBy: deciderUserId,
                  approvedAt: new Date(),
                }
              : { status: AdvanceStatus.rejected },
        });
        const row = await tx.labourAdvance.findUnique({
          where: { id },
          select: { companyId: true },
        });
        return { moved: result.count === 1, companyId: row?.companyId };
      },
    );
    if (!moved || !companyId) return;
    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_ADVANCE,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { [outcome]: true },
      accountId: deciderUserId ?? undefined,
      companyId,
      ipAddress,
    });
  }

  private async submitForApproval(
    caller: AuthenticatedUser,
    advance: {
      id: string;
      companyId: string;
      workerId: string;
      amount: Prisma.Decimal | number;
    },
    makerUserId: string | null,
  ): Promise<void> {
    const worker = (await this.workerSummaries(caller, [advance.workerId])).get(
      advance.workerId,
    );
    const amount = Number(advance.amount).toLocaleString('en-IN', {
      style: 'currency',
      currency: 'INR',
    });
    await this.approvals.submit({
      companyId: advance.companyId,
      actionType: ACTION_LABOUR_ADVANCE,
      entityType: ACTION_LABOUR_ADVANCE,
      entityId: advance.id,
      originatorUserId: makerUserId,
      subject: `${worker?.fullName ?? 'Labour'}${
        worker?.labourCode ? ` (${worker.labourCode})` : ''
      } — advance of ${amount}`,
      href: webRoutes.labourAdvances(),
      viewPermission: Permission.LABOUR_APPROVE,
      // 036 O12: not whoever raised it. Workers have no logins, so there is no payee to exclude.
      excludedUserIds: [makerUserId],
    });
  }

  /** An advance raised before advances joined the spine is put into its chain when first decided. */
  private async ensureInChain(
    caller: AuthenticatedUser,
    advance: {
      id: string;
      companyId: string;
      workerId: string;
      amount: Prisma.Decimal;
      createdBy: string | null;
    },
  ): Promise<boolean> {
    const state = await this.approvals.stateOfSystem(
      ACTION_LABOUR_ADVANCE,
      advance.id,
      advance.companyId,
    );
    if (state) return false;
    await this.submitForApproval(caller, advance, advance.createdBy);
    return true;
  }

  /**
   * Puts every pending advance with no approval chain into one (2026-10-20) — those raised before
   * labour advances joined the spine, so they reach the Approvals queue rather than waiting for somebody to
   * open the module screen. Idempotent; run by `npm run backfill:approvals`. Returns how many it
   * submitted.
   */
  async backfillApprovals(): Promise<number> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.labourAdvance.findMany({
          where: { status: AdvanceStatus.pending, deletedAt: null },
        }),
    );
    let submitted = 0;
    for (const advance of rows) {
      // A cross-company system caller: it is used only to read the worker's name.
      const system = {
        id: advance.createdBy ?? '',
        companyId: advance.companyId,
        selectedCompanyId: null,
        permissions: [Permission.CROSS_COMPANY_ACCESS],
        roleIds: [],
      } as unknown as AuthenticatedUser;
      if (await this.ensureInChain(system, advance)) submitted += 1;
    }
    return submitted;
  }

  /** Disburses an approved advance: its outstanding balance becomes the full amount
   * and recovery begins from the configured start period (US7 AC4). */
  async disburse(caller: AuthenticatedUser, id: string, ipAddress: string) {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.labourAdvance.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) {
          throw new NotFoundException(`Advance ${id} not found`);
        }
        assertInScope(caller, existing, `Advance ${id}`);
        await this.assertAdvancesAllowed(existing.companyId);
        if (existing.status !== AdvanceStatus.approved) {
          throw new ConflictException(
            'Only an approved advance can be disbursed',
          );
        }
        return tx.labourAdvance.update({
          where: { id },
          data: {
            status: AdvanceStatus.disbursed,
            outstandingBalance: existing.amount,
            disbursedOn: new Date(),
          },
        });
      },
    );
    await this.audit(
      AuditAction.UPDATE,
      id,
      updated.companyId,
      caller,
      ipAddress,
    );
    return this.viewOf(caller, updated);
  }

  /** One advance's view with its names, for the responses to a single change. */
  private async viewOf(
    caller: AuthenticatedUser,
    row: Parameters<LabourAdvanceService['toView']>[0] & { workerId: string },
  ): Promise<AdvanceView> {
    const workers = await this.workerSummaries(caller, [row.workerId]);
    const people = await this.refs.userNames([row.createdBy, row.approvedBy]);
    return this.toView(row, workers.get(row.workerId), people);
  }

  private toView(
    row: {
      id: string;
      workerId: string;
      amount: Prisma.Decimal;
      reason: string;
      recoveryInstalments: number;
      instalmentAmount: Prisma.Decimal;
      recoveryStartPeriod: Date;
      outstandingBalance: Prisma.Decimal;
      exceedsLimit: boolean;
      status: AdvanceStatus;
      createdBy: string | null;
      approvedBy: string | null;
    },
    worker: WorkerSummary | undefined,
    people: Map<string, string>,
  ): AdvanceView {
    return {
      id: row.id,
      workerId: row.workerId,
      amount: row.amount.toNumber(),
      reason: row.reason,
      recoveryInstalments: row.recoveryInstalments,
      instalmentAmount: row.instalmentAmount.toNumber(),
      recoveryStartPeriod: row.recoveryStartPeriod.toISOString().slice(0, 10),
      outstandingBalance: row.outstandingBalance.toNumber(),
      exceedsLimit: row.exceedsLimit,
      status: row.status,
      recoveryAtRisk: worker?.status === WorkerStatus.inactive,
      workerName: worker?.fullName ?? null,
      labourCode: worker?.labourCode ?? null,
      createdBy: row.createdBy,
      createdByName: row.createdBy ? people.get(row.createdBy) ?? null : null,
      approvedBy: row.approvedBy,
      approvedByName: row.approvedBy
        ? people.get(row.approvedBy) ?? null
        : null,
    };
  }

  /**
   * Today's daily rate for the advance limit: the worker's override, else their site's rate for
   * their gender (031), else the pre-031 skill default.
   */
  private async workerDailyRate(
    caller: AuthenticatedUser,
    workerId: string,
    companyId: string,
  ): Promise<number | null> {
    const worker = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourWorker.findUnique({
          where: { id: workerId },
          select: {
            rateOverride: true,
            skillCategoryId: true,
            siteId: true,
            gender: true,
            deletedAt: true,
            companyId: true,
          },
        }),
    );
    // 036 O14: a cross-company caller sees every company's workers, so the worker is compared with
    // the company the advance is for, not merely found.
    if (!worker || worker.deletedAt || worker.companyId !== companyId) {
      throw new BadRequestException(`Worker ${workerId} not found`);
    }
    if (worker.rateOverride) return worker.rateOverride.toNumber();
    if (worker.gender) {
      const today = parseDateOnly(
        zonedDateOnly(new Date(), this.refs.timeZone),
      );
      const siteRate = await withRlsContext(
        this.prisma,
        rlsContextFor(caller),
        (tx) =>
          this.siteRates.resolve(tx, {
            siteId: worker.siteId,
            gender: worker.gender,
            date: today,
          }),
      );
      if (siteRate !== null) return siteRate;
    }
    if (!worker.skillCategoryId) return null;
    const category = await this.skillCategories.getById(
      caller,
      worker.skillCategoryId,
    );
    return category?.defaultDailyRate ?? null;
  }

  private async workerSummaries(
    caller: AuthenticatedUser,
    workerIds: string[],
  ): Promise<Map<string, WorkerSummary>> {
    if (workerIds.length === 0) return new Map();
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourWorker.findMany({
          where: { id: { in: [...new Set(workerIds)] } },
          select: { id: true, status: true, fullName: true, labourCode: true },
        }),
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string | null,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_ADVANCE,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
