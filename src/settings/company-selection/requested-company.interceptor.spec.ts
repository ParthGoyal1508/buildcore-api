import { BadRequestException } from '@nestjs/common';
import { Permission } from '@prisma/client';
import { lastValueFrom, of } from 'rxjs';

import { createPrismaMock } from '../testing/prisma-mock';
import { RequestedCompanyInterceptor } from './requested-company.interceptor';

const crossCompany = {
  id: 'u-1',
  companyId: null,
  permissions: [Permission.CROSS_COMPANY_ACCESS],
  roleNames: [],
};
const scoped = { id: 'u-2', companyId: 'co-1', permissions: [], roleNames: [] };

const run = (
  user: object,
  request: { query?: object; body?: object },
  known: string[] = ['co-1'],
) => {
  const prisma = createPrismaMock({
    company: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.filter((id) => known.includes(id)).map((id) => ({ id })),
        ),
      ),
    },
  });
  const interceptor = new RequestedCompanyInterceptor(prisma as never);
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ user, ...request }) }),
  };
  const handled = jest.fn(() => of('handled'));
  return {
    result: lastValueFrom(
      interceptor.intercept(context as never, { handle: handled }),
    ),
    prisma,
    handled,
  };
};

describe('RequestedCompanyInterceptor', () => {
  it('refuses a query companyId that names no company', async () => {
    const { result, handled } = run(crossCompany, {
      query: { companyId: 'undefined' },
    });
    await expect(result).rejects.toBeInstanceOf(BadRequestException);
    await expect(result).rejects.toMatchObject({
      response: { code: 'UNKNOWN_COMPANY' },
    });
    expect(handled).not.toHaveBeenCalled();
  });

  it('refuses one in the body too', async () => {
    const { result } = run(crossCompany, { body: { companyId: 'nope' } });
    await expect(result).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a real company through', async () => {
    const { result } = run(crossCompany, { query: { companyId: 'co-1' } });
    await expect(result).resolves.toBe('handled');
  });

  it('asks nothing when no company is named', async () => {
    const { result, prisma } = run(crossCompany, { query: {} });
    await expect(result).resolves.toBe('handled');
    expect(prisma.tx.company.findMany).not.toHaveBeenCalled();
  });

  it("ignores a company-scoped caller's companyId, which nothing uses", async () => {
    const { result, prisma } = run(scoped, {
      query: { companyId: 'undefined' },
    });
    await expect(result).resolves.toBe('handled');
    expect(prisma.tx.company.findMany).not.toHaveBeenCalled();
  });
});
