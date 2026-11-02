import { Permission } from '@prisma/client';

import type { DashboardContext } from '../context';
import {
  HeldFromSubcontractorsWidget,
  OutgoingSources,
  PlantPayableWidget,
  TotalPayableWidget,
} from './money-panel.providers';

/** The Outgoing panel (054): each part behind its own screen's permission, the total included. */
describe('money panel widgets', () => {
  const ctxFor = (permissions: Permission[]): DashboardContext =>
    ({
      user: { permissions },
      companyId: 'company-1',
      cache: new Map(),
    } as unknown as DashboardContext);

  const inventory = { unpaidBillsTotal: jest.fn().mockResolvedValue(100) };
  const projects = {
    getSubcontractorPosition: jest
      .fn()
      .mockResolvedValue({ outstanding: 200, retentionHeld: 70 }),
  };
  const labour = { wagesOwed: jest.fn().mockResolvedValue(300) };
  const plant = {
    unpaidBillsTotals: jest
      .fn()
      .mockResolvedValue({ hire: 40, maintenance: 60 }),
  };
  const sources = new OutgoingSources(
    inventory as never,
    projects as never,
    labour as never,
    plant as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('totals every part for a caller who may see them all', async () => {
    const ctx = ctxFor([
      Permission.INVENTORY,
      Permission.PROJECT_FINANCIALS,
      Permission.LABOUR_APPROVE,
      Permission.HIRE_BILLS,
      Permission.MAINTENANCE,
    ]);
    await expect(new TotalPayableWidget(sources).compute(ctx)).resolves.toBe(
      700,
    );
  });

  it('leaves out, and never reads, a part the caller may not see', async () => {
    const ctx = ctxFor([Permission.INVENTORY, Permission.HIRE_BILLS]);
    await expect(new TotalPayableWidget(sources).compute(ctx)).resolves.toBe(
      140,
    );
    await expect(new PlantPayableWidget(sources).compute(ctx)).resolves.toBe(
      40,
    );
    expect(labour.wagesOwed).not.toHaveBeenCalled();
    expect(projects.getSubcontractorPosition).not.toHaveBeenCalled();
  });

  it('reads each module once per request, however many cards use it', async () => {
    const ctx = ctxFor([Permission.PROJECT_FINANCIALS, Permission.MAINTENANCE]);
    await new TotalPayableWidget(sources).compute(ctx);
    await new PlantPayableWidget(sources).compute(ctx);
    await new HeldFromSubcontractorsWidget(sources).compute(ctx);
    expect(plant.unpaidBillsTotals).toHaveBeenCalledTimes(1);
    expect(projects.getSubcontractorPosition).toHaveBeenCalledTimes(1);
  });

  it("declares the union of its parts' permissions as what it requires", () => {
    expect(new PlantPayableWidget(sources).requires).toEqual([
      Permission.HIRE_BILLS,
      Permission.MAINTENANCE,
      Permission.MAINTENANCE_PAY,
    ]);
  });
});
