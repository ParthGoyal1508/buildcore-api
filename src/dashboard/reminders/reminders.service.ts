import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  Permission,
  Prisma,
  ReminderSeverity,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { SettingsConfig } from '../../common/configs/config.interface';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { zonedDateOnly } from '../../hr/leave/leave-days';
import { MAX_REMINDERS_PER_RESPONSE } from '../constants/dashboard.constants';
import { ListRemindersDto } from './dto/list-reminders.dto';
import { SnoozeReminderDto } from './dto/snooze-reminder.dto';
import { ReminderRuleRegistry } from './reminder-rule.registry';
import {
  compareReminders,
  daysBetween,
  parseReminderId,
  Reminder,
  ReminderRuleProvider,
  reminderIdFor,
  severityFor,
  UnavailableRuleSource,
} from './reminder-rule.types';

export interface ReminderListResponse {
  reminders: Reminder[];
  /** Rules whose module is not built yet (spec FR-031). */
  unavailable: UnavailableRuleSource[];
  /** True when `MAX_REMINDERS_PER_RESPONSE` clipped the list. */
  truncated: boolean;
}

export interface ReminderCountResponse {
  total: number;
  bySeverity: Record<ReminderSeverity, number>;
}

export interface SweepResult {
  emitted: number;
  escalated: number;
  closed: number;
}

/** One (company, rule, entity) triple — the identity de-duplication keys off. */
type LedgerKey = string;

const ledgerKey = (companyId: string, ruleKey: string, entityId: string) =>
  `${companyId}|${ruleKey}|${entityId}`;

/**
 * The cross-module reminders engine (spec US9, FR-028 to FR-035).
 *
 * Evaluates every registered `ReminderRuleProvider` into one unified list, applies
 * snoozes, and maintains the emitted-notification ledger that makes de-duplication
 * possible. It owns no business data of its own: every reminder originates in some
 * other module's records, reached through that module's own provider rather than a
 * cross-schema query (Principle I).
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    configService: ConfigService,
    private readonly registry: ReminderRuleRegistry,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
  }

  /**
   * Today, as a calendar date in the configured business timezone.
   *
   * Not `new Date()` truncated to UTC: due dates are calendar dates, and a server
   * running in UTC would consider a certificate expiring "today" in Kolkata to be
   * expiring tomorrow for the five and a half hours after 18:30 local. Same helper
   * the leave and attendance code already uses for the same reason.
   */
  private today(): string {
    return zonedDateOnly(new Date(), this.timeZone);
  }

  /**
   * Resolves which companies a request may see (spec FR-035).
   *
   * Returns the RLS context to evaluate under, plus the company to filter candidates
   * by in application code — belt to RLS's braces, exactly as `companyScope()` does
   * for the settings resources. `null` means every company.
   */
  private resolveScope(
    caller: AuthenticatedUser,
    query: Pick<ListRemindersDto, 'scope' | 'companyId'>,
  ): { ctx: RlsContext; companyId: string | null } {
    const crossCompany = caller.permissions.includes(
      Permission.CROSS_COMPANY_ACCESS,
    );

    if (query.scope === 'all') {
      if (!crossCompany) {
        throw new ForbiddenException(
          'scope=all requires CROSS_COMPANY_ACCESS.',
        );
      }
      return { ctx: { isSuperAdmin: true }, companyId: null };
    }

    if (crossCompany) {
      // A cross-company caller with no company of their own and no `companyId` has
      // not named a scope at all. Returning every company would silently grant what
      // `scope=all` exists to request explicitly, so this is the one case that
      // widens — and it widens only for someone who already holds the bypass.
      const companyId = query.companyId ?? caller.companyId ?? null;
      return { ctx: { isSuperAdmin: true }, companyId };
    }

    // `companyId` is ignored outright for everyone else: a query parameter must
    // never widen a caller's scope.
    return {
      ctx: { isSuperAdmin: false, companyId: caller.companyId },
      companyId: caller.companyId ?? null,
    };
  }

  /**
   * Evaluates every available rule and resolves candidates into reminders.
   *
   * Providers run in parallel and are isolated from one another: a rule that throws
   * is logged and reported as contributing nothing, rather than failing the whole
   * request. FR-031 requires that treatment for an unbuilt module, and a rule that
   * breaks in production deserves no worse — one bad rule must not blank the
   * reminders screen for every other module.
   */
  private async collect(
    ctx: RlsContext,
    companyId: string | null,
  ): Promise<{
    reminders: Reminder[];
    unavailable: UnavailableRuleSource[];
    /** Every (company, rule, entity) currently due, snoozed ones included. */
    live: Set<LedgerKey>;
  }> {
    const today = this.today();
    const unavailable: UnavailableRuleSource[] = [];
    const available: ReminderRuleProvider[] = [];
    const disabled = await this.disabledRuleKeys(ctx);

    for (const provider of this.registry.rules()) {
      // An operator switched this rule off. It contributes nothing and is NOT
      // reported as unavailable: `module_pending` means "cannot be computed yet",
      // and saying that about a rule someone deliberately silenced would send the
      // reader looking for a missing module instead of at the flag they set.
      if (disabled.has(provider.ruleKey)) continue;

      if (provider.isAvailable()) {
        available.push(provider);
      } else {
        unavailable.push({
          ruleKey: provider.ruleKey,
          sourceModule: provider.sourceModule,
          reason: 'module_pending',
        });
      }
    }

    const results = await Promise.all(
      available.map(async (provider) => {
        try {
          const candidates = await provider.evaluate(ctx);
          return candidates
            .filter((c) => companyId === null || c.companyId === companyId)
            .map((candidate): Reminder => {
              const dueDate = candidate.dueDate.toISOString().slice(0, 10);
              const daysRemaining = daysBetween(today, dueDate);
              return {
                id: reminderIdFor(provider.ruleKey, candidate.entityId),
                ruleKey: provider.ruleKey,
                sourceModule: provider.sourceModule,
                type: provider.type,
                entityType: provider.entityType,
                entityId: candidate.entityId,
                companyId: candidate.companyId,
                subject: candidate.subject,
                dueDate,
                daysRemaining,
                severity: severityFor(daysRemaining, provider.severityLadder),
                ...(candidate.actionLink
                  ? { actionLink: candidate.actionLink }
                  : {}),
              };
            });
        } catch (error) {
          this.logger.error(
            `Reminder rule "${provider.ruleKey}" failed to evaluate; ` +
              'it contributes nothing to this response.',
            error instanceof Error ? error.stack : String(error),
          );
          unavailable.push({
            ruleKey: provider.ruleKey,
            sourceModule: provider.sourceModule,
            reason: 'module_pending',
          });
          return [];
        }
      }),
    );

    const reminders = results.flat();
    return {
      reminders,
      unavailable,
      live: new Set(
        reminders.map((r) => ledgerKey(r.companyId, r.ruleKey, r.entityId)),
      ),
    };
  }

  /**
   * Rules an operator has switched off in the catalogue.
   *
   * `ReminderRuleRegistry` writes `enabled` and never overwrites it on redeploy,
   * precisely so it can be used this way — a rule producing noise at 3am can be
   * silenced with one UPDATE instead of a release. Read on every evaluation rather
   * than cached at boot, because the whole point is that it takes effect without a
   * restart.
   */
  private async disabledRuleKeys(ctx: RlsContext): Promise<Set<string>> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.reminderRule.findMany({
        where: { enabled: false },
        select: { ruleKey: true },
      }),
    );
    return new Set(rows.map((row) => row.ruleKey));
  }

  /** Every (company, rule, entity) currently suppressed by a live snooze. */
  private async activeSnoozes(
    ctx: RlsContext,
    today: string,
  ): Promise<Set<LedgerKey>> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.reminderSnooze.findMany({
        // Inclusive: a snooze "until the 14th" still suppresses on the 14th and
        // lapses on the 15th.
        where: { snoozeUntil: { gte: new Date(`${today}T00:00:00Z`) } },
        select: { companyId: true, ruleKey: true, entityId: true },
      }),
    );
    return new Set(
      rows.map((r) => ledgerKey(r.companyId, r.ruleKey, r.entityId)),
    );
  }

  /** The reminders list (spec FR-029, FR-030, FR-031, FR-034, FR-035). */
  async list(
    caller: AuthenticatedUser,
    query: ListRemindersDto,
  ): Promise<ReminderListResponse> {
    const { ctx, companyId } = this.resolveScope(caller, query);
    const [{ reminders, unavailable }, snoozed] = await Promise.all([
      this.collect(ctx, companyId),
      this.activeSnoozes(ctx, this.today()),
    ]);

    const visible = reminders
      .filter(
        (r) => !snoozed.has(ledgerKey(r.companyId, r.ruleKey, r.entityId)),
      )
      .filter((r) => (query.type ? r.type === query.type : true))
      .filter((r) => (query.module ? r.sourceModule === query.module : true))
      .filter((r) => (query.severity ? r.severity === query.severity : true))
      .sort(compareReminders);

    return {
      reminders: visible.slice(0, MAX_REMINDERS_PER_RESPONSE),
      unavailable,
      truncated: visible.length > MAX_REMINDERS_PER_RESPONSE,
    };
  }

  /**
   * Counts by severity for the header badge (spec FR-011's shape, per AC10).
   *
   * Computed from the same `list()` call rather than a cheaper aggregate query,
   * because there is no table to aggregate over — a reminder exists only as the
   * result of evaluating its rule. Filters apply, so a badge can count one module.
   */
  async count(
    caller: AuthenticatedUser,
    query: ListRemindersDto,
  ): Promise<ReminderCountResponse> {
    const { reminders } = await this.list(caller, query);
    const bySeverity: Record<ReminderSeverity, number> = {
      [ReminderSeverity.info]: 0,
      [ReminderSeverity.warning]: 0,
      [ReminderSeverity.overdue]: 0,
    };
    for (const reminder of reminders) {
      bySeverity[reminder.severity] += 1;
    }
    return { total: reminders.length, bySeverity };
  }

  /**
   * Suppresses one reminder until a date (spec FR-034).
   *
   * The reminder must currently exist and be visible to the caller — resolved by
   * evaluating, since there is no row to look up. A snooze against something not
   * due, or due in another company, is a 404 for the same reason `assertInScope()`
   * reports one: a caller who may not see a record should not be able to confirm it
   * exists by snoozing it.
   */
  async snooze(
    caller: AuthenticatedUser,
    reminderId: string,
    dto: SnoozeReminderDto,
    ipAddress: string,
  ): Promise<{ id: string; snoozeUntil: string; reason: string }> {
    const parsed = parseReminderId(reminderId);
    if (!parsed) {
      throw new NotFoundException('Reminder not found');
    }

    const today = this.today();
    const snoozeUntil = dto.snoozeUntil.slice(0, 10);
    if (daysBetween(today, snoozeUntil) < 0) {
      throw new NotFoundException(
        'snoozeUntil is in the past — the reminder would reappear immediately.',
      );
    }

    const { ctx, companyId } = this.resolveScope(caller, {});
    const { reminders } = await this.collect(ctx, companyId);
    const reminder = reminders.find((r) => r.id === reminderId);
    if (!reminder) {
      throw new NotFoundException('Reminder not found');
    }

    await withRlsContext(this.prisma, ctx, async (tx) => {
      await tx.reminderSnooze.create({
        data: {
          companyId: reminder.companyId,
          ruleKey: reminder.ruleKey,
          entityType: reminder.entityType,
          entityId: reminder.entityId,
          snoozeUntil: new Date(`${snoozeUntil}T00:00:00Z`),
          reason: dto.reason,
          createdByUserId: caller.id,
        },
      });
      // FR-034 suppresses the reminder from notification as well as from the list.
      await tx.reminderNotification.updateMany({
        where: {
          companyId: reminder.companyId,
          ruleKey: reminder.ruleKey,
          entityId: reminder.entityId,
          closedAt: null,
        },
        data: { closedAt: new Date(), closeReason: 'snoozed' },
      });
    });

    await this.auditLog.record({
      entityType: AuditEntityType.REMINDER,
      action: AuditAction.UPDATE,
      entityId: reminderId,
      changes: {
        ruleKey: reminder.ruleKey,
        entityType: reminder.entityType,
        entityId: reminder.entityId,
        subject: reminder.subject,
        severity: reminder.severity,
        snoozeUntil,
        reason: dto.reason,
      } as Prisma.InputJsonValue,
      accountId: caller.id,
      companyId: reminder.companyId,
      ipAddress,
    });

    return { id: reminderId, snoozeUntil, reason: dto.reason };
  }

  /**
   * The de-duplication engine (spec FR-032, FR-033).
   *
   * Reconciles the ledger against what is due right now, across every tenant:
   *
   * - due, nothing open        → emit
   * - due, open at same band   → leave alone (this is FR-032's guarantee)
   * - due, open at other band  → close the old row, emit at the new band (escalation,
   *                              and de-escalation too — a due date pushed back is
   *                              just as much a change worth announcing)
   * - not due, still open      → close it (FR-033: the condition was resolved)
   * - snoozed, still open      → close it, marked as snoozed rather than resolved
   *
   * Runs under the cross-company bypass because it is a system job with no caller —
   * the same reasoning `ComplianceCheckCron` records.
   */
  async evaluateAndEmit(): Promise<SweepResult> {
    const ctx: RlsContext = { isSuperAdmin: true };
    const today = this.today();

    const [{ reminders, live }, snoozed] = await Promise.all([
      this.collect(ctx, null),
      this.activeSnoozes(ctx, today),
    ]);

    return withRlsContext(this.prisma, ctx, async (tx) => {
      const open = await tx.reminderNotification.findMany({
        where: { closedAt: null },
        select: {
          id: true,
          companyId: true,
          ruleKey: true,
          entityId: true,
          severity: true,
        },
      });
      const openByKey = new Map(
        open.map((row) => [
          ledgerKey(row.companyId, row.ruleKey, row.entityId),
          row,
        ]),
      );

      const now = new Date();
      const closeIds: { id: string; reason: string }[] = [];
      const toEmit: Reminder[] = [];
      let escalated = 0;

      for (const reminder of reminders) {
        const key = ledgerKey(
          reminder.companyId,
          reminder.ruleKey,
          reminder.entityId,
        );
        if (snoozed.has(key)) continue;

        const existing = openByKey.get(key);
        if (!existing) {
          toEmit.push(reminder);
          continue;
        }
        if (existing.severity === reminder.severity) continue;

        closeIds.push({ id: existing.id, reason: 'escalated' });
        toEmit.push(reminder);
        escalated += 1;
      }

      for (const row of open) {
        const key = ledgerKey(row.companyId, row.ruleKey, row.entityId);
        if (snoozed.has(key)) {
          closeIds.push({ id: row.id, reason: 'snoozed' });
        } else if (!live.has(key)) {
          closeIds.push({ id: row.id, reason: 'resolved' });
        }
      }

      for (const { id, reason } of closeIds) {
        await tx.reminderNotification.update({
          where: { id },
          data: { closedAt: now, closeReason: reason },
        });
      }

      if (toEmit.length > 0) {
        await tx.reminderNotification.createMany({
          data: toEmit.map((reminder) => ({
            companyId: reminder.companyId,
            ruleKey: reminder.ruleKey,
            entityType: reminder.entityType,
            entityId: reminder.entityId,
            subject: reminder.subject,
            dueDate: new Date(`${reminder.dueDate}T00:00:00Z`),
            severity: reminder.severity,
          })),
        });
      }

      const result: SweepResult = {
        emitted: toEmit.length,
        escalated,
        closed: closeIds.length,
      };
      this.logger.log(
        `Reminder sweep: ${result.emitted} emitted ` +
          `(${result.escalated} escalations), ${result.closed} closed.`,
      );
      return result;
    });
  }
}
