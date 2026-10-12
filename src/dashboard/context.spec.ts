import { Permission } from '@prisma/client';

import { buildDashboardContext } from './context';

/**
 * Which company the dashboard computes for.
 *
 * A cross-company caller has two: the one they belong to, and the one they have chosen
 * in the switcher. `rlsContextFor` honours the choice and every module screen scopes
 * through it — but this context took `user.companyId`, the other one. So after
 * switching company the Plant Register listed the newly selected company's two machines
 * while the Total Machinery card said 3 and Contract Value showed the previous
 * company's ₹37.11 crore. One company's dashboard reporting another's figures, with
 * nothing on screen to say so.
 *
 * Observed against the running server before the fix, on one token in one minute:
 * register 2 machines, card 3.
 *
 * **Three cases, because the first alone could be satisfied by swapping the bug round.**
 * A selection must win; a company-scoped caller must still get their own company (a
 * selection can never widen scope — `rlsContextFor`'s own safety property); and a
 * cross-company caller who has chosen nothing must behave exactly as before, which is
 * the case that stops this being a regression for an administrator who never touches
 * the switcher.
 */
const user = (over: Record<string, unknown>) =>
  ({
    id: 'u1',
    companyId: null,
    permissions: [],
    roleIds: [],
    ...over,
  } as never);

describe('the company the dashboard computes for', () => {
  it('is the selected company, not the caller’s own', () => {
    const ctx = buildDashboardContext(
      user({
        companyId: 'own-company',
        permissions: [Permission.CROSS_COMPANY_ACCESS],
        selectedCompanyId: 'chosen-company',
      }),
      '127.0.0.1',
    );

    expect(ctx.companyId).toBe('chosen-company');
    // And the RLS context agrees, so a provider reading either cannot disagree with the
    // other — which is what made the original defect invisible to every mocked test.
    expect(ctx.rls.companyId).toBe('chosen-company');
  });

  it('is a company-scoped caller’s own company, whatever a selection says', () => {
    // A selection narrows, never widens. Were this to follow the selection, a stale one
    // would be a cross-tenant read rather than a smaller view.
    const ctx = buildDashboardContext(
      user({
        companyId: 'own-company',
        permissions: [Permission.DASHBOARD],
        selectedCompanyId: 'someone-elses-company',
      }),
      '127.0.0.1',
    );

    expect(ctx.companyId).toBe('own-company');
  });

  it('falls back to the caller’s own company when nothing is selected', () => {
    const ctx = buildDashboardContext(
      user({
        companyId: 'own-company',
        permissions: [Permission.CROSS_COMPANY_ACCESS],
        selectedCompanyId: null,
      }),
      '127.0.0.1',
    );

    expect(ctx.companyId).toBe('own-company');
  });

  it('leaves it empty for a company-less Super Admin, which the controllers refuse', () => {
    const ctx = buildDashboardContext(
      user({ permissions: [Permission.CROSS_COMPANY_ACCESS] }),
      '127.0.0.1',
    );

    expect(ctx.companyId).toBe('');
  });

  it('keeps caller.companyId as the caller’s own, which is what Caller means', () => {
    // `callerFrom` in `hr` does the same: services taking a `Caller` scope through
    // `caller.rls` and read this only where "the company this person belongs to" is
    // meant. Changing it here would have moved the defect rather than fixed it.
    const ctx = buildDashboardContext(
      user({
        companyId: 'own-company',
        permissions: [Permission.CROSS_COMPANY_ACCESS],
        selectedCompanyId: 'chosen-company',
      }),
      '127.0.0.1',
    );

    expect(ctx.caller.companyId).toBe('own-company');
    expect(ctx.caller.rls.companyId).toBe('chosen-company');
  });
});
