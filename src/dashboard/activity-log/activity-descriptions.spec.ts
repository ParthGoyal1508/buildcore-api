import { AuditAction, AuditEntityType } from '@prisma/client';

import { describeEvent, kindOf, targetLabelOf } from './activity-descriptions';

/** The activity log says what happened, not which id it happened to (2026-10-15). */
describe('activity log descriptions', () => {
  const row = (
    entityType: AuditEntityType,
    action: AuditAction,
    changes: unknown,
    entityId: string | null = 'cmu40n37q0004123n5lj36wq3',
  ) => ({ entityType, action, entityId, changes: changes as never });

  it('names a password confirmation and what it was for', () => {
    expect(
      describeEvent(
        row(AuditEntityType.USER_ACCOUNT, AuditAction.READ, {
          event: 'password_confirmed',
          purpose: 'cash-visibility',
        }),
      ),
    ).toBe('Confirmed their password for Personal Settings');
  });

  it('says which way the cash switch went, for rows from before the event was named too', () => {
    expect(
      describeEvent(
        row(AuditEntityType.COMPANY, AuditAction.UPDATE, {
          event: 'cash_visibility_changed',
          hideCashTransactions: true,
          confirmedByPassword: true,
        }),
      ),
    ).toBe('Hid cash transactions');
    expect(
      describeEvent(
        row(AuditEntityType.COMPANY, AuditAction.UPDATE, {
          hideCashTransactions: false,
          confirmedByPassword: true,
        }),
      ),
    ).toBe('Showed cash transactions');
  });

  it('leaves an ordinary update to "Updated"', () => {
    expect(
      describeEvent(
        row(AuditEntityType.COMPANY, AuditAction.UPDATE, { name: 'x' }),
      ),
    ).toBeNull();
  });

  it('names the record when it is known, and its kind — never its id — when not', () => {
    const r = row(AuditEntityType.PROJECT, AuditAction.CREATE, null, 'p1');
    expect(
      targetLabelOf(r, new Map([['PROJECT:p1', 'PRPL-2401 — Whitefield']])),
    ).toBe('PRPL-2401 — Whitefield');
    expect(targetLabelOf(r, new Map())).toBe('a project');
    expect(kindOf(AuditEntityType.GOODS_RECEIPT_NOTE)).toBe(
      'goods receipt note',
    );
    expect(kindOf(AuditEntityType.DWR)).toBe('daily work report');
  });
});
