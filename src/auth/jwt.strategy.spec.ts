import { Permission } from '@prisma/client';

import { JwtStrategy } from './jwt.strategy';

/**
 * 058: what company a request works in. An all-companies user's `companyId` becomes the company
 * they selected (else their home company), with `homeCompanyId` kept; a Super Admin and everyone
 * else are untouched.
 */
describe('JwtStrategy.validate — the working company (058)', () => {
  const build = (
    user: Record<string, unknown>,
    selected: string | null,
    working = 'co-working',
  ) => {
    const authService = {
      loadUserWithPermissions: jest.fn().mockResolvedValue({
        status: 'active',
        homeCompanyId: user.companyId ?? null,
        ...user,
      }),
    };
    const companySelection = {
      resolve: jest.fn().mockResolvedValue(selected),
      workingCompanyFor: jest.fn(
        async ({
          selected: s,
          companyId,
        }: {
          selected: string | null;
          companyId: string | null;
        }) => s ?? (working === 'home' ? companyId : working),
      ),
    };
    const strategy = new JwtStrategy(
      authService as never,
      companySelection as never,
      {
        get: () => ({ jwtAccessSecret: 'test-secret' }),
      } as never,
    );
    return { strategy, companySelection };
  };

  it('puts an all-companies user in the company they selected', async () => {
    const { strategy } = build(
      { id: 'u1', companyId: 'co-prpl', multiCompany: true, permissions: [] },
      'co-te',
    );
    const user = await strategy.validate({ userId: 'u1' } as never);
    expect(user.companyId).toBe('co-te');
    expect(user.homeCompanyId).toBe('co-prpl');
    // Never a selection a Super Admin would read as "scoped but bypass-capable".
    expect(user.selectedCompanyId).toBeNull();
  });

  it('keeps an all-companies user in their home company until they choose', async () => {
    const { strategy } = build(
      { id: 'u1', companyId: 'co-prpl', multiCompany: true, permissions: [] },
      null,
      'home',
    );
    const user = await strategy.validate({ userId: 'u1' } as never);
    expect(user.companyId).toBe('co-prpl');
    expect(user.homeCompanyId).toBe('co-prpl');
  });

  it('moves them off a closed home company, to the company the selection service names', async () => {
    const { strategy } = build(
      { id: 'u1', companyId: 'co-closed', multiCompany: true, permissions: [] },
      null,
      'co-open',
    );
    const user = await strategy.validate({ userId: 'u1' } as never);
    expect(user.companyId).toBe('co-open');
    expect(user.homeCompanyId).toBe('co-closed');
  });

  it('leaves a Super Admin exactly as before: home company, selection on the side', async () => {
    const { strategy, companySelection } = build(
      {
        id: 'sa',
        companyId: 'co-prpl',
        multiCompany: false,
        permissions: [Permission.CROSS_COMPANY_ACCESS],
      },
      'co-te',
    );
    const user = await strategy.validate({ userId: 'sa' } as never);
    expect(user.companyId).toBe('co-prpl');
    expect(user.selectedCompanyId).toBe('co-te');
    expect(companySelection.workingCompanyFor).not.toHaveBeenCalled();
  });

  it('leaves a single-company user exactly as before', async () => {
    const { strategy } = build(
      { id: 'u2', companyId: 'co-prpl', multiCompany: false, permissions: [] },
      null,
    );
    const user = await strategy.validate({ userId: 'u2' } as never);
    expect(user.companyId).toBe('co-prpl');
    expect(user.selectedCompanyId).toBeNull();
  });
});
