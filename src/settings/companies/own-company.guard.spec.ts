import { ForbiddenException } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { OwnCompanyGuard } from './own-company.guard';

/** 2026-10-16 access-control audit, C4. */
describe('OwnCompanyGuard', () => {
  const guard = new OwnCompanyGuard();
  const run = (
    permissions: Permission[],
    method: string,
    params: Record<string, string> = {},
  ) =>
    guard.canActivate({
      switchToHttp: () => ({
        getRequest: () => ({
          user: { companyId: 'co-1', permissions },
          method,
          params,
        }),
      }),
    } as never);

  const scoped = [Permission.COMPANY_SETTINGS];
  const group = [Permission.COMPANY_SETTINGS, Permission.CROSS_COMPANY_ACCESS];

  it('lets a company administrator manage their own company', () => {
    expect(run(scoped, 'PATCH', { id: 'co-1' })).toBe(true);
  });

  it('refuses another company', () => {
    expect(() => run(scoped, 'GET', { id: 'co-2' })).toThrow(
      ForbiddenException,
    );
  });

  it('refuses creating a company without group access', () => {
    expect(() => run(scoped, 'POST')).toThrow(ForbiddenException);
  });

  it('lets a group administrator reach any company and create one', () => {
    expect(run(group, 'PATCH', { id: 'co-2' })).toBe(true);
    expect(run(group, 'POST')).toBe(true);
  });
});
