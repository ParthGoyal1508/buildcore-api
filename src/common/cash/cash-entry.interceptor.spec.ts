import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessLevel, Permission } from '@prisma/client';
import { of, lastValueFrom } from 'rxjs';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { REQUIRES_CASH_ENTRY_KEY } from '../decorators/cash-entry.decorator';
import { ACCESS_LEVEL_KEY } from '../decorators/access-level.decorator';
import {
  CASH_ENTRY_REFUSAL_CODE,
  CashEntryInterceptor,
  findCashInRequest,
  mayEnterCash,
  maySeeCashBreakup,
} from './cash-entry.interceptor';

/**
 * 019 FR-017a, FR-017b — tasks T076 and T079.
 *
 * The refusal is the easy half. **The half that matters is that a bank-mode write is
 * untouched**: this is a cash permission, not a payments permission, and if holding it became a
 * condition of recording any payment, every accounts clerk in the company would need the right
 * to take cash — the control would have made cash handling broader rather than narrower.
 */

type Grant = { permission: Permission; level: AccessLevel };

function user(grants: Grant[]): AuthenticatedUser {
  return {
    id: 'u1',
    companyId: 'c1',
    permissions: [...new Set(grants.map((g) => g.permission))],
    grants,
  } as unknown as AuthenticatedUser;
}

const CASHIER = user([
  { permission: Permission.INVENTORY, level: AccessLevel.write },
  { permission: Permission.CASH_ENTRY, level: AccessLevel.read },
  { permission: Permission.CASH_ENTRY, level: AccessLevel.write },
]);

const CLERK = user([
  { permission: Permission.INVENTORY, level: AccessLevel.read },
  { permission: Permission.INVENTORY, level: AccessLevel.write },
]);

function contextFor(
  request: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): { context: ExecutionContext; reflector: Reflector } {
  const context = {
    getType: () => 'http',
    getHandler: () =>
      function handler() {
        return undefined;
      },
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
  return { context, reflector };
}

async function run(
  request: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
  refusals?: { record: jest.Mock },
): Promise<unknown> {
  const { context, reflector } = contextFor(request, metadata);
  const interceptor = new CashEntryInterceptor(
    reflector,
    refusals as never | undefined,
  );
  const result = interceptor.intercept(context, {
    handle: () => of('handler ran'),
  });
  return lastValueFrom(result);
}

describe('CashEntryInterceptor', () => {
  it('refuses a cash payment from a caller without CASH_ENTRY', async () => {
    await expect(
      run({
        user: CLERK,
        method: 'POST',
        url: '/inventory/payments',
        body: { vendorId: 'v1', amount: 5000, paymentMode: 'cash' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('names the field it refused on', async () => {
    try {
      await run({
        user: CLERK,
        method: 'POST',
        body: { paymentMode: 'cash' },
      });
      fail('expected a refusal');
    } catch (error) {
      const response = (error as ForbiddenException).getResponse() as {
        code: string;
        message: string;
      };
      expect(response.code).toBe(CASH_ENTRY_REFUSAL_CODE);
      // The caller's next question is always *which* part of this was cash — most often a
      // denomination breakup they did not realise they were sending.
      expect(response.message).toContain('paymentMode');
    }
  });

  it('leaves a bank-mode write alone for the same caller', async () => {
    // The half that matters. A payments permission would have refused this too.
    await expect(
      run({
        user: CLERK,
        method: 'POST',
        body: { vendorId: 'v1', amount: 5000, paymentMode: 'bank_transfer' },
      }),
    ).resolves.toBe('handler ran');
  });

  it('admits a cash payment from a CASH_ENTRY holder', async () => {
    await expect(
      run({
        user: CASHIER,
        method: 'POST',
        body: { paymentMode: 'cash' },
      }),
    ).resolves.toBe('handler ran');
  });

  it('refuses cash nested inside a line of a batch', async () => {
    // A top-level-only check would be evaded by nesting, without anybody intending to evade it.
    await expect(
      run({
        user: CLERK,
        method: 'PATCH',
        body: {
          lines: [
            { id: 'a', mode: 'bank' },
            { id: 'b', mode: 'cash' },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a denomination breakup whatever the row mode says', async () => {
    // Cash by construction. A breakup with no mode field beside it would otherwise pass.
    await expect(
      run({
        user: CLERK,
        method: 'POST',
        body: { denominationBreakup: { '500': 4 } },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('leaves a read alone even when it filters on cash', async () => {
    // `ListPaymentsDto` takes `paymentMode` as a filter. Without the level check, a read-only
    // clerk would be refused the list of cash payments they are explicitly allowed to see.
    await expect(
      run({
        user: CLERK,
        method: 'GET',
        body: {},
        query: { paymentMode: 'cash' },
      }),
    ).resolves.toBe('handler ran');
  });

  it('leaves a POST marked @RequireLevel(read) alone', async () => {
    await expect(
      run(
        { user: CLERK, method: 'POST', body: { paymentMode: 'cash' } },
        { [ACCESS_LEVEL_KEY]: AccessLevel.read },
      ),
    ).resolves.toBe('handler ran');
  });

  it('refuses a @RequiresCashEntry route with nothing cash-looking in its body', async () => {
    // The escape hatch for a route that derives the mode server-side. Nothing uses it today;
    // this is what makes it work the day something does.
    await expect(
      run(
        { user: CLERK, method: 'POST', body: { sheetId: 's1' } },
        { [REQUIRES_CASH_ENTRY_KEY]: true },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('records the refusal', async () => {
    const refusals = { record: jest.fn() };
    await expect(
      run(
        {
          user: CLERK,
          method: 'POST',
          route: { path: '/inventory/payments' },
          body: { paymentMode: 'cash' },
        },
        {},
        refusals,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(refusals.record).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredPermission: Permission.CASH_ENTRY,
        requiredLevel: AccessLevel.write,
        path: '/inventory/payments',
      }),
    );
  });

  it('refuses even when recording the refusal throws', async () => {
    // A 403 must not become a 500 because a log write failed.
    const refusals = {
      record: jest.fn(() => {
        throw new Error('log is down');
      }),
    };
    await expect(
      run(
        { user: CLERK, method: 'POST', body: { paymentMode: 'cash' } },
        {},
        refusals,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never records a resolved URL', async () => {
    const refusals = { record: jest.fn() };
    await expect(
      run(
        {
          user: CLERK,
          method: 'POST',
          url: '/inventory/payments/pay_7Hs3?draft=1',
          body: { paymentMode: 'cash' },
        },
        {},
        refusals,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // A security log accumulating record ids becomes a store of personal data nobody
    // classified. With no route template available the query string at least goes.
    expect(refusals.record.mock.calls[0][0].path).toBe(
      '/inventory/payments/pay_7Hs3',
    );
  });
});

describe('findCashInRequest', () => {
  it('returns the path, not merely true', () => {
    expect(
      findCashInRequest({ lines: [{ mode: 'bank' }, { mode: 'cash' }] }),
    ).toBe('lines[1].mode');
  });

  it('ignores a cash-looking value under a field that is not a mode field', () => {
    // `referenceNumber: 'cash counter 2'` is not a payment mode.
    expect(findCashInRequest({ referenceNumber: 'cash' })).toBeNull();
  });

  it('ignores a Date', () => {
    // Same conservatism as the outbound walk: only literal objects are ours to read.
    expect(findCashInRequest({ date: new Date() })).toBeNull();
  });

  it('finds nothing in an empty body', () => {
    expect(findCashInRequest({})).toBeNull();
    expect(findCashInRequest(null)).toBeNull();
  });
});

describe('the two levels mean different things', () => {
  it('write records cash, read does not', () => {
    const readOnly = user([
      { permission: Permission.CASH_ENTRY, level: AccessLevel.read },
    ]);
    expect(mayEnterCash(readOnly)).toBe(false);
    expect(maySeeCashBreakup(readOnly)).toBe(true);
  });

  it('a write holder sees the breakup even with no read row', () => {
    // A migrated role might hold write alone. Hiding the breakup from somebody entitled to pay
    // against it is the failure FR-017d exists to fix.
    const writeOnly = user([
      { permission: Permission.CASH_ENTRY, level: AccessLevel.write },
    ]);
    expect(maySeeCashBreakup(writeOnly)).toBe(true);
  });

  it('falls back to the area for a caller with no grants at all', () => {
    // An account whose roles predate the level backfill must not be locked out by a model it
    // has no rows for — the same fallback `PermissionsGuard` makes.
    const legacy = {
      permissions: [Permission.CASH_ENTRY],
      grants: [],
    } as unknown as AuthenticatedUser;
    expect(mayEnterCash(legacy)).toBe(true);
  });

  it('a caller holding nothing holds neither', () => {
    expect(mayEnterCash(CLERK)).toBe(false);
    expect(maySeeCashBreakup(CLERK)).toBe(false);
  });
});
