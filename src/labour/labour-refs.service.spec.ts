import { BadRequestException } from '@nestjs/common';
import { Permission } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/authenticated-user';
import { LabourRefsService } from './labour-refs.service';

describe('LabourRefsService.assertActiveContractor (036 3e)', () => {
  const caller = {
    id: 'u1',
    companyId: 'home',
    permissions: [Permission.CROSS_COMPANY_ACCESS],
  } as unknown as AuthenticatedUser;

  const build = (vendor: unknown) => {
    const partners = { getVendorById: jest.fn().mockResolvedValue(vendor) };
    const service = new LabourRefsService(
      {} as never,
      partners as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return service;
  };

  const vendor = (over: Record<string, unknown> = {}) => ({
    id: 'v1',
    name: 'Dummy Contractor Test Firm',
    code: 'V1',
    type: 'contractor',
    active: true,
    companyId: 'c1',
    ...over,
  });

  it('accepts an active contractor of the worker company', async () => {
    await expect(
      build(vendor()).assertActiveContractor(caller, 'v1', 'c1'),
    ).resolves.toBeUndefined();
  });

  it("refuses another company's contractor", async () => {
    await expect(
      build(vendor({ companyId: 'c2' })).assertActiveContractor(
        caller,
        'v1',
        'c1',
      ),
    ).rejects.toThrow(/another company/);
  });

  it('refuses an unknown or inactive contractor', async () => {
    await expect(
      build(null).assertActiveContractor(caller, 'v1', 'c1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      build(vendor({ active: false })).assertActiveContractor(
        caller,
        'v1',
        'c1',
      ),
    ).rejects.toThrow(/not active/);
  });
});
