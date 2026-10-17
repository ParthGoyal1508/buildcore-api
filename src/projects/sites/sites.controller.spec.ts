import { Permission } from '@prisma/client';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { SitesController } from './sites.controller';
import type { SitesService } from './sites.service';

/**
 * 036 B2/B3: the site picker lists the company the caller is *working in*.
 *
 * It read `user.companyId ?? companyId`, so a cross-company caller who had switched to another
 * company still got their home company's sites in every picker that calls it.
 */
describe('SitesController.list (036 selected company)', () => {
  const listForCompany = jest.fn().mockResolvedValue([]);
  const controller = new SitesController({
    listForCompany,
  } as unknown as SitesService);
  const request = { ip: '127.0.0.1' } as Request;

  beforeEach(() => listForCompany.mockClear());

  it('uses the selected company, not the home company, for a cross-company caller', async () => {
    const user = {
      id: 'u1',
      companyId: 'home',
      selectedCompanyId: 'selected',
      permissions: [Permission.PROJECTS, Permission.CROSS_COMPANY_ACCESS],
      grants: [],
    } as unknown as AuthenticatedUser;

    await controller.list(user, request);

    expect(listForCompany).toHaveBeenCalledWith(expect.anything(), 'selected');
  });

  it('ignores a requested company for a company-scoped caller', async () => {
    const user = {
      id: 'u2',
      companyId: 'own',
      permissions: [Permission.PROJECTS],
      grants: [],
    } as unknown as AuthenticatedUser;

    await controller.list(user, request, 'other');

    expect(listForCompany).toHaveBeenCalledWith(expect.anything(), 'own');
  });

  it('honours the requested company for a cross-company caller with no selection', async () => {
    const user = {
      id: 'u3',
      companyId: 'home',
      permissions: [Permission.PROJECTS, Permission.CROSS_COMPANY_ACCESS],
      grants: [],
    } as unknown as AuthenticatedUser;

    await controller.list(user, request, 'requested');

    expect(listForCompany).toHaveBeenCalledWith(expect.anything(), 'requested');
  });
});
