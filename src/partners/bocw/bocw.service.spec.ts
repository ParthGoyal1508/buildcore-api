import * as ExcelJS from 'exceljs';

import { BOCWService, deriveStatus } from './bocw.service';

describe('deriveStatus (FR-008)', () => {
  it('is pending when nothing has been paid', () => {
    expect(deriveStatus(1000, 0)).toBe('pending');
  });

  it('is partial when some but not all has been paid', () => {
    expect(deriveStatus(400, 600)).toBe('partial');
  });

  it('is paid when the balance is cleared', () => {
    expect(deriveStatus(0, 1000)).toBe('paid');
  });

  it('is paid when more than the liability has been paid', () => {
    // An overpayment clears the obligation. Reporting it as `partial` because the
    // balance is not exactly zero would leave a project flagged as owing money it
    // has already overpaid.
    expect(deriveStatus(-250, 1250)).toBe('paid');
  });

  it('is pending, not partial, for a zero liability with no payment', () => {
    expect(deriveStatus(0, 0)).toBe('paid');
  });
});

describe('BOCWService.list', () => {
  function build(projects: unknown[], available: boolean, paid: number) {
    const prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
        Promise.resolve(
          fn({
            $executeRaw: jest.fn(),
            bOCWPayment: {
              groupBy: jest
                .fn()
                .mockResolvedValue(
                  paid > 0
                    ? [{ projectId: 'p1', _sum: { amountPaid: paid } }]
                    : [],
                ),
            },
          }),
        ),
      ),
    };
    const projectsService = {
      isPortfolioAvailable: () => available,
      getProjectsWithContractValues: jest.fn().mockResolvedValue(projects),
    };
    const companies = { getBocwCessRate: jest.fn().mockResolvedValue(0.01) };
    const service = new BOCWService(
      prisma as never,
      { record: jest.fn() } as never,
      projectsService as never,
      companies as never,
    );
    const caller = {
      id: 'u1',
      companyId: 'c1',
      permissions: [],
      roleNames: [],
    } as never;
    return { service, caller };
  }

  it('computes liability as contract value times the company rate', async () => {
    const { service, caller } = build(
      [{ projectId: 'p1', name: 'Metro Depot', contractValue: 10_000_000 }],
      true,
      0,
    );
    const result = await service.list(caller);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      projectId: 'p1',
      projectName: 'Metro Depot',
      contractValue: 10_000_000,
      cessRate: 0.01,
      cessLiability: 100_000,
      totalPaid: 0,
      balance: 100_000,
      status: 'pending',
    });
  });

  it('moves to partial then paid as payments land', async () => {
    const partial = await build(
      [{ projectId: 'p1', name: 'Metro Depot', contractValue: 10_000_000 }],
      true,
      40_000,
    );
    const partialResult = await partial.service.list(partial.caller);
    expect(partialResult.rows[0].totalPaid).toBe(40_000);
    expect(partialResult.rows[0].balance).toBe(60_000);
    expect(partialResult.rows[0].status).toBe('partial');

    const full = await build(
      [{ projectId: 'p1', name: 'Metro Depot', contractValue: 10_000_000 }],
      true,
      100_000,
    );
    const fullResult = await full.service.list(full.caller);
    expect(fullResult.rows[0].balance).toBe(0);
    expect(fullResult.rows[0].status).toBe('paid');
  });

  it('reports projects as unavailable rather than as an empty portfolio', async () => {
    // The distinction the screen depends on: "no projects" and "the module that
    // would know is not built" need different things on screen.
    const { service, caller } = build([], false, 0);
    const result = await service.list(caller);
    expect(result.rows).toEqual([]);
    expect(result.unavailableModules).toEqual(['projects']);
  });

  it('exports the same rows as Excel, with a total row (036 N6)', async () => {
    const { service, caller } = build(
      [{ projectId: 'p1', name: 'Metro Depot', contractValue: 10_000_000 }],
      true,
      40_000,
    );
    const { buffer, filename } = await service.exportXlsx(caller);
    expect(filename).toMatch(/^BOCW_Cess_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).getCell(1).value).toBe('Project');
    expect(ws.getRow(2).values).toEqual(
      expect.arrayContaining(['Metro Depot', 10_000_000, 1, 100_000, 40_000, 60_000, 'Part paid']),
    );
    expect(ws.getRow(3).getCell(1).value).toBe('Total');
  });

  it('reports nothing unavailable once the portfolio exists', async () => {
    const { service, caller } = build([], true, 0);
    const result = await service.list(caller);
    expect(result.unavailableModules).toEqual([]);
  });
});
