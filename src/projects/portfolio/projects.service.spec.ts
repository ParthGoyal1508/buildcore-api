import { ConflictException } from '@nestjs/common';

import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { ProjectsService } from './projects.service';

/**
 * `findOne()` aggregates across four modules, two of which do not exist. The point
 * of these tests is that the absent ones degrade rather than throw — and that they
 * degrade *visibly*, since an empty list that silently means "we could not ask" is
 * the one outcome the detail page must never present.
 */
describe('ProjectsService.findOne', () => {
  const caller = callerFor('company-1');

  const projectRow = {
    id: 'project-1',
    companyId: 'company-1',
    name: 'Ring Road Phase II',
    isLocked: false,
  };

  const serviceWith = (
    overrides: Record<string, unknown> = {},
    employees: Record<string, unknown> = {},
  ) => {
    const prisma = createPrismaMock({
      project: { findUnique: jest.fn().mockResolvedValue(projectRow) },
      site: { findMany: jest.fn().mockResolvedValue([{ id: 'site-1' }]) },
      dailyWorkReport: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      rABill: { findMany: jest.fn().mockResolvedValue([]) },
      revenue: { findMany: jest.fn().mockResolvedValue([]) },
      ...overrides,
    });
    return new ProjectsService(
      prisma as never,
      { record: jest.fn() } as never,
      { next: jest.fn() } as never,
      {
        listActiveBySiteIds: jest.fn().mockResolvedValue([]),
        ...employees,
      } as never,
      // No machinery or materials source registered — the state a deployment
      // without 006 or 009 is in, and what `unavailableModules` reports.
      {
        machinerySource: () => null,
        materialsSource: () => null,
      } as never,
    );
  };

  it('returns empty machinery and materials without error, since 006 and 009 do not exist', async () => {
    const detail = await serviceWith().findOne(caller, 'project-1');
    expect(detail.tabs.machinery).toEqual([]);
    expect(detail.tabs.materials).toEqual([]);
  });

  it('names plant and inventory as unavailable rather than implying there are none', async () => {
    const detail = await serviceWith().findOne(caller, 'project-1');
    expect(detail.unavailableModules).toEqual(['plant', 'inventory']);
  });

  it('reads the employee roster through HR, never from the hr schema directly', async () => {
    const listActiveBySiteIds = jest.fn().mockResolvedValue([
      {
        id: 'emp-1',
        employeeCode: 'ACME-EMP-0001',
        name: 'A Worker',
        designationId: null,
      },
    ]);
    const detail = await serviceWith({}, { listActiveBySiteIds }).findOne(
      caller,
      'project-1',
    );

    // Called with the project's own site ids: a project has no employees, its sites
    // do.
    expect(listActiveBySiteIds).toHaveBeenCalledWith(expect.anything(), [
      'site-1',
    ]);
    expect(detail.tabs.employees).toHaveLength(1);
    // Employees are NOT in unavailableModules — 005 has shipped, so this is a real
    // answer rather than a gap.
    expect(detail.unavailableModules).not.toContain('hr');
  });

  it('splits revenue by status rather than reporting one total', async () => {
    const service = serviceWith({
      revenue: {
        findMany: jest.fn().mockResolvedValue([
          { amount: 100, status: 'received' },
          { amount: 250, status: 'received' },
          { amount: 400, status: 'pending' },
        ]),
      },
    });

    const detail = await service.findOne(caller, 'project-1');
    expect(detail.tabs.revenueSummary).toEqual({
      totalReceived: 350,
      totalPending: 400,
    });
  });
});

describe('ProjectsService outward contract', () => {
  const service = () =>
    new ProjectsService(
      createPrismaMock() as never,
      { record: jest.fn() } as never,
      { next: jest.fn() } as never,
      {} as never,
      { machinerySource: () => null, materialsSource: () => null } as never,
    );

  it('reports the portfolio as available, which 007 branches on', () => {
    // 007 uses this to tell "no projects" from "module not built". It returned false
    // until this story shipped; flipping it is the whole of that contract.
    expect(service().isPortfolioAvailable()).toBe(true);
  });

  it('still reports zero work-order value, because US6 has not shipped', async () => {
    // The WorkOrder table exists but nothing writes to it. Returning 0 understates
    // subcontractor cost rather than failing — the caller must say so.
    await expect(
      service().getWorkOrderTotalByProject('project-1'),
    ).resolves.toBe(0);
  });
});

describe('ProjectsService.remove', () => {
  const caller = callerFor('company-1');

  it('refuses when recorded data would be cascaded away, naming each kind', async () => {
    const deleteFn = jest.fn();
    const prisma = createPrismaMock({
      project: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'project-1',
          companyId: 'company-1',
          name: 'Ring Road Phase II',
          _count: {
            dailyWorkReports: 12,
            revenues: 0,
            raBills: 3,
            boqTaskGroups: 0,
          },
        }),
        delete: deleteFn,
      },
    });
    const service = new ProjectsService(
      prisma as never,
      { record: jest.fn() } as never,
      { next: jest.fn() } as never,
      {} as never,
      { machinerySource: () => null, materialsSource: () => null } as never,
    );

    const attempt = service.remove(caller, 'project-1', '10.0.0.1');
    await expect(attempt).rejects.toThrow(ConflictException);
    await expect(attempt).rejects.toThrow(
      /12 work report\(s\), 3 RA bill\(s\)/,
    );
    expect(deleteFn).not.toHaveBeenCalled();
  });
});
