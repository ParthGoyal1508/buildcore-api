import { ReminderSeverity } from '@prisma/client';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { zonedDateOnly } from '../../hr/leave/leave-days';
import { ReminderCandidate, ReminderRuleProvider } from './reminder-rule.types';
import { RemindersService } from './reminders.service';

const TIME_ZONE = 'Asia/Kolkata';
const COMPANY = 'company-1';

/** Today as the service sees it, so due dates in the tests are relative to the same day. */
const today = () => zonedDateOnly(new Date(), TIME_ZONE);

/** A calendar date `offset` days from today, as the `@db.Date` values Prisma returns. */
const daysFromToday = (offset: number): Date =>
  new Date(Date.parse(`${today()}T00:00:00Z`) + offset * 86_400_000);

/**
 * A rule standing in for one a real module would register.
 *
 * Its candidates are settable between sweeps, which is what makes "evaluate the same
 * data twice" and "the condition was resolved" expressible as tests rather than as
 * assertions about mock call counts.
 */
class FakeRule implements ReminderRuleProvider {
  readonly sourceModule: string;
  readonly type: string;
  readonly entityType = 'TEST_DOCUMENT';
  readonly leadDays = 30;
  readonly severityLadder = { warnWithinDays: 7 };

  constructor(
    readonly ruleKey = 'testing-document-expiry',
    public candidates: ReminderCandidate[] = [],
    private available = true,
    overrides: { sourceModule?: string; type?: string } = {},
  ) {
    this.sourceModule = overrides.sourceModule ?? 'testing';
    this.type = overrides.type ?? 'document_expiry';
  }

  isAvailable(): boolean {
    return this.available;
  }

  evaluate(): Promise<ReminderCandidate[]> {
    return Promise.resolve(this.candidates);
  }
}

interface LedgerRow {
  id: string;
  companyId: string;
  ruleKey: string;
  entityType: string;
  entityId: string;
  subject: string;
  dueDate: Date;
  severity: ReminderSeverity;
  closedAt: Date | null;
  closeReason: string | null;
}

/**
 * A stateful stand-in for the `ReminderNotification` table.
 *
 * Stateful rather than a set of `jest.fn()` return values because every FR-032/FR-033
 * behaviour under test is about what a *second* evaluation does given what the first
 * one wrote. A stateless mock can only prove which queries were issued, which is the
 * one thing that does not matter here.
 */
class FakeLedger {
  rows: LedgerRow[] = [];
  private nextId = 1;
  snoozes: { companyId: string; ruleKey: string; entityId: string }[] = [];

  get open(): LedgerRow[] {
    return this.rows.filter((r) => r.closedAt === null);
  }

  delegates() {
    return {
      reminderNotification: {
        findMany: jest.fn(() => Promise.resolve(this.open)),
        update: jest.fn(
          ({
            where,
            data,
          }: {
            where: { id: string };
            data: { closedAt: Date; closeReason: string };
          }) => {
            const row = this.rows.find((r) => r.id === where.id);
            if (row) {
              row.closedAt = data.closedAt;
              row.closeReason = data.closeReason;
            }
            return Promise.resolve(row);
          },
        ),
        updateMany: jest.fn(
          ({
            where,
            data,
          }: {
            where: { ruleKey: string; entityId: string };
            data: { closedAt: Date; closeReason: string };
          }) => {
            let count = 0;
            for (const row of this.open) {
              if (
                row.ruleKey === where.ruleKey &&
                row.entityId === where.entityId
              ) {
                row.closedAt = data.closedAt;
                row.closeReason = data.closeReason;
                count += 1;
              }
            }
            return Promise.resolve({ count });
          },
        ),
        createMany: jest.fn(
          ({
            data,
          }: {
            data: Omit<LedgerRow, 'id' | 'closedAt' | 'closeReason'>[];
          }) => {
            for (const row of data) {
              this.rows.push({
                ...row,
                id: `notification-${this.nextId++}`,
                closedAt: null,
                closeReason: null,
              });
            }
            return Promise.resolve({ count: data.length });
          },
        ),
      },
      reminderSnooze: {
        findMany: jest.fn(() => Promise.resolve(this.snoozes)),
        create: jest.fn(() => Promise.resolve({})),
      },
    };
  }
}

const serviceWith = (rules: ReminderRuleProvider[], ledger: FakeLedger) => {
  const prisma = createPrismaMock(ledger.delegates());
  const audit = { record: jest.fn() };
  const config = { get: () => ({ timezone: TIME_ZONE }) };
  return {
    audit,
    service: new RemindersService(
      prisma as never,
      audit as never,
      config as never,
      { rules: () => rules } as never,
    ),
  };
};

const candidate = (
  entityId: string,
  dueInDays: number,
  subject = `Certificate ${entityId}`,
): ReminderCandidate => ({
  companyId: COMPANY,
  entityId,
  subject,
  dueDate: daysFromToday(dueInDays),
});

describe('RemindersService', () => {
  const caller = callerFor(COMPANY);

  describe('severity and ordering (FR-030)', () => {
    it('bands by days remaining, counting a due date today as not yet overdue', async () => {
      const rule = new FakeRule('testing-document-expiry', [
        candidate('a', 20),
        candidate('b', 3),
        candidate('c', 0),
        candidate('d', -5),
      ]);
      const { service } = serviceWith([rule], new FakeLedger());

      const { reminders } = await service.list(caller, {});
      const bands = Object.fromEntries(
        reminders.map((r) => [r.entityId, r.severity]),
      );

      expect(bands).toEqual({
        a: ReminderSeverity.info,
        b: ReminderSeverity.warning,
        // Due today is `warning`, not `overdue` — nothing is late on its own due date.
        c: ReminderSeverity.warning,
        d: ReminderSeverity.overdue,
      });
    });

    it('reports days remaining as negative once overdue', async () => {
      const rule = new FakeRule('testing-document-expiry', [
        candidate('a', -5),
      ]);
      const { service } = serviceWith([rule], new FakeLedger());

      const { reminders } = await service.list(caller, {});

      expect(reminders[0].daysRemaining).toBe(-5);
    });

    it('sorts overdue first, then soonest due', async () => {
      const rule = new FakeRule('testing-document-expiry', [
        candidate('soon', 2),
        candidate('later', 25),
        candidate('very-late', -30),
        candidate('late', -1),
      ]);
      const { service } = serviceWith([rule], new FakeLedger());

      const { reminders } = await service.list(caller, {});

      // Oldest breach first within the overdue group — a list that led with the
      // *least* overdue item would bury the one that has been ignored longest.
      expect(reminders.map((r) => r.entityId)).toEqual([
        'very-late',
        'late',
        'soon',
        'later',
      ]);
    });
  });

  describe('unavailable modules (FR-031)', () => {
    it('contributes nothing and reports the rule rather than failing', async () => {
      const pending = new FakeRule('machinery-service-due', [], false);
      const live = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service } = serviceWith([pending, live], new FakeLedger());

      const { reminders, unavailable } = await service.list(caller, {});

      expect(reminders).toHaveLength(1);
      expect(unavailable).toEqual([
        {
          ruleKey: 'machinery-service-due',
          sourceModule: 'testing',
          reason: 'module_pending',
        },
      ]);
    });

    it('isolates a rule that throws, so one bad rule cannot blank the screen', async () => {
      const broken = new FakeRule('testing-broken', [candidate('x', 1)]);
      broken.evaluate = () => Promise.reject(new Error('boom'));
      const live = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service } = serviceWith([broken, live], new FakeLedger());

      const { reminders, unavailable } = await service.list(caller, {});

      expect(reminders.map((r) => r.entityId)).toEqual(['a']);
      expect(unavailable.map((u) => u.ruleKey)).toEqual(['testing-broken']);
    });
  });

  describe('de-duplication across repeated evaluation (FR-032, SC-A02)', () => {
    it('emits once, then emits nothing for unchanged data', async () => {
      const ledger = new FakeLedger();
      const rule = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service } = serviceWith([rule], ledger);

      const first = await service.evaluateAndEmit();
      const second = await service.evaluateAndEmit();
      const third = await service.evaluateAndEmit();

      expect(first.emitted).toBe(1);
      expect(second.emitted).toBe(0);
      expect(third.emitted).toBe(0);
      expect(ledger.open).toHaveLength(1);
    });

    it('emits anew at the higher band when a reminder escalates', async () => {
      const ledger = new FakeLedger();
      const rule = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service } = serviceWith([rule], ledger);

      await service.evaluateAndEmit();
      // The same document, now a day past its due date.
      rule.candidates = [candidate('a', -1)];
      const escalation = await service.evaluateAndEmit();

      expect(escalation.escalated).toBe(1);
      expect(escalation.emitted).toBe(1);
      expect(ledger.open).toHaveLength(1);
      expect(ledger.open[0].severity).toBe(ReminderSeverity.overdue);

      const closed = ledger.rows.filter((r) => r.closedAt !== null);
      expect(closed).toHaveLength(1);
      expect(closed[0].severity).toBe(ReminderSeverity.warning);
      expect(closed[0].closeReason).toBe('escalated');
    });

    it('does not re-emit while the severity band is unchanged, even as the date moves', async () => {
      const ledger = new FakeLedger();
      const rule = new FakeRule('testing-document-expiry', [candidate('a', 6)]);
      const { service } = serviceWith([rule], ledger);

      await service.evaluateAndEmit();
      // Still inside the warning band: 6 days becomes 4, no announcement is due.
      rule.candidates = [candidate('a', 4)];
      const second = await service.evaluateAndEmit();

      expect(second.emitted).toBe(0);
      expect(ledger.open).toHaveLength(1);
    });
  });

  describe('resolution (FR-033)', () => {
    it('closes the open notification once the condition no longer holds', async () => {
      const ledger = new FakeLedger();
      const rule = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service } = serviceWith([rule], ledger);

      await service.evaluateAndEmit();
      // The document was renewed, so the rule stops producing it.
      rule.candidates = [];
      const afterRenewal = await service.evaluateAndEmit();

      expect(afterRenewal.closed).toBe(1);
      expect(ledger.open).toHaveLength(0);
      expect(ledger.rows[0].closeReason).toBe('resolved');
    });

    it('drops the reminder from the list too, with no dismiss action', async () => {
      const rule = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service } = serviceWith([rule], new FakeLedger());

      expect((await service.list(caller, {})).reminders).toHaveLength(1);
      rule.candidates = [];
      expect((await service.list(caller, {})).reminders).toHaveLength(0);
    });
  });

  describe('snooze (FR-034)', () => {
    it('suppresses the reminder from the list while the snooze is live', async () => {
      const ledger = new FakeLedger();
      const rule = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service } = serviceWith([rule], ledger);

      expect((await service.list(caller, {})).reminders).toHaveLength(1);

      ledger.snoozes = [
        {
          companyId: COMPANY,
          ruleKey: 'testing-document-expiry',
          entityId: 'a',
        },
      ];

      expect((await service.list(caller, {})).reminders).toHaveLength(0);
    });

    it('closes the open notification as snoozed rather than resolved', async () => {
      const ledger = new FakeLedger();
      const rule = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service } = serviceWith([rule], ledger);

      await service.evaluateAndEmit();
      ledger.snoozes = [
        {
          companyId: COMPANY,
          ruleKey: 'testing-document-expiry',
          entityId: 'a',
        },
      ];
      await service.evaluateAndEmit();

      expect(ledger.open).toHaveLength(0);
      // 'resolved' would be a lie: the certificate is still expiring, someone just
      // asked not to be told about it yet.
      expect(ledger.rows[0].closeReason).toBe('snoozed');
    });

    it('lets the reminder back once the snooze lapses, even after escalating', async () => {
      const ledger = new FakeLedger();
      const rule = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service } = serviceWith([rule], ledger);

      ledger.snoozes = [
        {
          companyId: COMPANY,
          ruleKey: 'testing-document-expiry',
          entityId: 'a',
        },
      ];
      expect((await service.list(caller, {})).reminders).toHaveLength(0);

      // The query filters on `snoozeUntil >= today`, so a lapsed snooze simply stops
      // being returned — this is that row falling out of the result.
      ledger.snoozes = [];
      rule.candidates = [candidate('a', -2)];

      const { reminders } = await service.list(caller, {});
      expect(reminders).toHaveLength(1);
      expect(reminders[0].severity).toBe(ReminderSeverity.overdue);
    });

    it('refuses to snooze a reminder that is not currently due', async () => {
      const rule = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service } = serviceWith([rule], new FakeLedger());

      await expect(
        service.snooze(
          caller,
          'testing-document-expiry:not-a-real-entity',
          { snoozeUntil: '2099-01-01', reason: 'because' },
          '10.0.0.1',
        ),
      ).rejects.toThrow(/not found/i);
    });

    it('audit-logs the snooze with the reason', async () => {
      const rule = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service, audit } = serviceWith([rule], new FakeLedger());

      await service.snooze(
        caller,
        'testing-document-expiry:a',
        {
          snoozeUntil: daysFromToday(10).toISOString().slice(0, 10),
          reason: 'Renewal lodged',
        },
        '10.0.0.1',
      );

      expect(audit.record).toHaveBeenCalledTimes(1);
      const entry = audit.record.mock.calls[0][0];
      expect(entry.entityType).toBe('REMINDER');
      expect(entry.changes.reason).toBe('Renewal lodged');
    });
  });

  describe('counts (AC10)', () => {
    it('counts by severity and totals them', async () => {
      const rule = new FakeRule('testing-document-expiry', [
        candidate('a', -1),
        candidate('b', -9),
        candidate('c', 3),
        candidate('d', 20),
      ]);
      const { service } = serviceWith([rule], new FakeLedger());

      expect(await service.count(caller, {})).toEqual({
        total: 4,
        bySeverity: { overdue: 2, warning: 1, info: 1 },
      });
    });
  });

  describe('filters (AC2)', () => {
    it('narrows by severity, type and module independently', async () => {
      const docs = new FakeRule('testing-document-expiry', [
        candidate('a', -1),
        candidate('b', 20),
      ]);
      const serviceDue = new FakeRule(
        'testing-service-due',
        [candidate('c', 2)],
        true,
        {
          sourceModule: 'other',
          type: 'service_due',
        },
      );
      const { service: reminders } = serviceWith(
        [docs, serviceDue],
        new FakeLedger(),
      );

      expect(
        (
          await reminders.list(caller, { severity: ReminderSeverity.overdue })
        ).reminders.map((r) => r.entityId),
      ).toEqual(['a']);
      expect(
        (await reminders.list(caller, { type: 'service_due' })).reminders.map(
          (r) => r.entityId,
        ),
      ).toEqual(['c']);
      expect(
        (await reminders.list(caller, { module: 'other' })).reminders.map(
          (r) => r.entityId,
        ),
      ).toEqual(['c']);
    });
  });

  describe('company scoping (FR-035)', () => {
    it('refuses scope=all without CROSS_COMPANY_ACCESS', async () => {
      const rule = new FakeRule('testing-document-expiry', [candidate('a', 3)]);
      const { service } = serviceWith([rule], new FakeLedger());

      await expect(service.list(caller, { scope: 'all' })).rejects.toThrow(
        /CROSS_COMPANY_ACCESS/,
      );
    });

    it('drops candidates belonging to another company', async () => {
      const rule = new FakeRule('testing-document-expiry', [
        candidate('mine', 3),
        { ...candidate('theirs', 3), companyId: 'company-2' },
      ]);
      const { service } = serviceWith([rule], new FakeLedger());

      const { reminders } = await service.list(caller, {});

      expect(reminders.map((r) => r.entityId)).toEqual(['mine']);
    });
  });
});
