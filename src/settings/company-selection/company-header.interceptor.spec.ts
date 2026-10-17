import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission } from '@prisma/client';
import { lastValueFrom, of } from 'rxjs';

import { createPrismaMock } from '../testing/prisma-mock';
import {
  COMPANY_CHANGED,
  CompanyHeaderInterceptor,
} from './company-header.interceptor';

const scoped = { id: 'u', companyId: 'co-A', permissions: [] };
const crossNoSelection = {
  id: 'u',
  companyId: 'co-A',
  permissions: [Permission.CROSS_COMPANY_ACCESS],
};
const crossSelectedB = { ...crossNoSelection, selectedCompanyId: 'co-B' };

function run(
  user: object | undefined,
  method: string,
  headers: Record<string, string> = {},
  exempt = false,
) {
  const prisma = createPrismaMock({
    company: { findUnique: jest.fn(async () => ({ name: 'Beta Infra' })) },
  });
  const reflector = { getAllAndOverride: jest.fn(() => exempt) };
  const interceptor = new CompanyHeaderInterceptor(
    reflector as unknown as Reflector,
    prisma as never,
  );
  const setHeader = jest.fn();
  const context = {
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ user, method, headers }),
      getResponse: () => ({ setHeader }),
    }),
  };
  const handler = { handle: jest.fn(() => of('ok')) };
  const result = lastValueFrom(
    interceptor.intercept(context as never, handler as never),
  );
  return { result, setHeader, handler };
}

describe('CompanyHeaderInterceptor (036 B17)', () => {
  it.each([
    ['a company-scoped caller', scoped, 'co-A'],
    ['a cross-company caller who selected B', crossSelectedB, 'co-B'],
    ['a cross-company caller with no selection', crossNoSelection, ''],
  ])('names the company for %s', async (_label, user, expected) => {
    const { result, setHeader } = run(user, 'GET');
    await result;
    expect(setHeader).toHaveBeenCalledWith('X-Company-Id', expected);
  });

  it('sets nothing for an unauthenticated request', async () => {
    const { result, setHeader } = run(undefined, 'POST', {
      'x-expected-company-id': 'co-Z',
    });
    expect(await result).toBe('ok');
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('refuses a save from a tab that thinks it is in another company', async () => {
    const { result, handler } = run(crossSelectedB, 'POST', {
      'x-expected-company-id': 'co-A',
    });
    const error = (await result.catch((e) => e)) as HttpException;
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      code: COMPANY_CHANGED,
      message:
        'Company was changed to Beta Infra in another tab. Reload to continue.',
      companyId: 'co-B',
      companyName: 'Beta Infra',
    });
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it.each([
    ['a matching header', 'PATCH', { 'x-expected-company-id': 'co-B' }, false],
    ['no header at all', 'DELETE', {}, false],
    ['a GET', 'GET', { 'x-expected-company-id': 'co-A' }, false],
    ['an exempt route', 'PUT', { 'x-expected-company-id': 'co-A' }, true],
  ])('lets %s through', async (_label, method, headers, exempt) => {
    const { result } = run(crossSelectedB, method, headers, exempt);
    expect(await result).toBe('ok');
  });
});
