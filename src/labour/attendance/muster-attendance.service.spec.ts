import {
  MusterAttendanceService,
  type MusterDay,
  type MusterWorkerRef,
} from './muster-attendance.service';

/**
 * The daily view's server-side name/code search (042): the muster can hold hundreds of workers,
 * and until now the search box could only sieve what the browser had — so the register and the
 * screen disagreed about who was on site. `search` narrows `items`; the summary still counts the
 * whole day, like `filter` always has.
 */
describe('MusterAttendanceService.daily search (042)', () => {
  const DATE = '2026-10-24';

  function worker(
    workerId: string,
    fullName: string,
    labourCode: string,
    status: MusterDay['status'] = 'full_day',
  ): { ref: MusterWorkerRef; days: Map<string, MusterDay> } {
    return {
      ref: {
        workerId,
        labourCode,
        fullName,
        fatherName: null,
        gender: null,
        contractorName: null,
        gangName: null,
        siteId: 'site-1',
        siteName: 'Depot',
      },
      days: new Map([
        [
          DATE,
          {
            date: DATE,
            punchIn: null,
            punchOut: null,
            hours: status === 'absent' ? null : 8,
            status,
            overtimeHours: 0,
            flag: null,
            manual: false,
          },
        ],
      ]),
    };
  }

  function build(grid: ReturnType<typeof worker>[]) {
    const service = new MusterAttendanceService(
      {} as never, // prisma — unused once collect is stubbed
      {} as never, // audit log
      {} as never, // refs
      {} as never, // storage
      {} as never, // images
      {} as never, // supervisor sites
      { today: () => '2026-10-25' } as never,
    );
    jest
      .spyOn(service, 'chosenSites')
      .mockResolvedValue([{ id: 'site-1', name: 'Depot' }] as never);
    jest.spyOn(service, 'collect').mockResolvedValue(grid);
    return service;
  }

  const caller = { id: 'u1', companyId: 'c1', permissions: [] } as never;

  it('matches the worker name case-insensitively', async () => {
    const service = build([
      worker('w1', 'Ram Kumar', 'LB-0001'),
      worker('w2', 'Shyam Singh', 'LB-0002'),
    ]);
    const result = await service.daily(caller, { date: DATE, search: 'rAm' });
    expect(result.items.map((r) => r.workerId)).toEqual(['w1']);
  });

  it('matches the labour code case-insensitively', async () => {
    const service = build([
      worker('w1', 'Ram Kumar', 'LB-0001'),
      worker('w2', 'Shyam Singh', 'LB-0002'),
    ]);
    const result = await service.daily(caller, {
      date: DATE,
      search: 'lb-0002',
    });
    expect(result.items.map((r) => r.workerId)).toEqual(['w2']);
  });

  it('keeps the summary over the whole day while narrowing the rows', async () => {
    const service = build([
      worker('w1', 'Ram Kumar', 'LB-0001'),
      worker('w2', 'Shyam Singh', 'LB-0002'),
    ]);
    const result = await service.daily(caller, { date: DATE, search: 'shyam' });
    expect(result.items).toHaveLength(1);
    expect(result.summary.workers).toBe(2);
    expect(result.summary.fullDay).toBe(2);
  });

  it('combines with the status filter, and no search returns everyone', async () => {
    const service = build([
      worker('w1', 'Ram Kumar', 'LB-0001'),
      worker('w2', 'Ram Prasad', 'LB-0002', 'absent'),
    ]);
    const both = await service.daily(caller, { date: DATE });
    expect(both.items).toHaveLength(2);

    const filtered = await service.daily(caller, {
      date: DATE,
      filter: 'absent',
      search: 'ram',
    });
    expect(filtered.items.map((r) => r.workerId)).toEqual(['w2']);
  });
});
