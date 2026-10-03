import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BoqService } from './boq.service';

const DEC = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);
const TODAY = new Date('2026-10-03T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** A BOQ line in whichever state the test needs. Defaults to the shape an import produces. */
function line(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'item-1',
    boqNo: '1',
    taskName: 'Excavation',
    unit: 'Cum',
    scopeQty: DEC('100'),
    rate: DEC('251'),
    doneQty: DEC('0'),
    perDayQty: null,
    startDate: null,
    finishDate: null,
    duration: null,
    isVariation: false,
    ...overrides,
  };
}

function serviceWith(
  items: ReturnType<typeof line>[],
  counts?: Record<string, number>,
) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    bOQTaskGroup: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'group-1',
          boqNo: '1',
          name: 'Earthwork',
          scopeQty: DEC('100'),
          startDate: null,
          finishDate: null,
          items,
        },
      ]),
    },
    bOQTaskItem: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'item-1',
        _count: counts ?? { dwrTasks: 0, clientBillLines: 0, awardLines: 0 },
      }),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { service: new BoqService(prisma as never), tx };
}

const CTX = { isSuperAdmin: false, companyId: 'company-1' };

describe('BoqService', () => {
  describe('the five states, which must be disjoint and cover every line', () => {
    it('calls a line with no finish date unplanned, not on time', async () => {
      const { service } = serviceWith([line()]);

      const alerts = await service.getAlerts(CTX, 'project-1', TODAY);

      // FR-048. This is the state of all 231 lines of a freshly imported tender, so getting it
      // wrong mislabels an entire project rather than an edge case.
      expect(alerts.unplanned).toHaveLength(1);
      expect(alerts.today).toHaveLength(0);
      expect(alerts.delayed).toHaveLength(0);
      expect(alerts.toBeDelayed).toHaveLength(0);
    });

    it('places a partially planned line in exactly one group', async () => {
      // A finish date and NO per-day quantity — the case the pre-amendment definition could not
      // decide, because it compared against `perDayQty` directly and would have found it null.
      const { service } = serviceWith([
        line({
          finishDate: day('2026-10-20'),
          startDate: day('2026-09-20'),
          doneQty: DEC('5'),
        }),
      ]);

      const alerts = await service.getAlerts(CTX, 'project-1', TODAY);

      const total =
        alerts.today.length +
        alerts.delayed.length +
        alerts.toBeDelayed.length +
        alerts.unplanned.length;
      // Needed is derived (95 pending over 17 days ≈ 5.6/day) against achieved (5 over 13 days
      // ≈ 0.38/day), so this one is at risk — but the assertion that matters is that it is in
      // one group and not two, and not in none.
      expect(total).toBe(1);
      expect(alerts.toBeDelayed).toHaveLength(1);
    });

    it('does not report a finished line as needing attention', async () => {
      const { service } = serviceWith([
        line({
          finishDate: day('2026-09-01'),
          startDate: day('2026-08-01'),
          doneQty: DEC('100'),
        }),
      ]);

      const alerts = await service.getAlerts(CTX, 'project-1', TODAY);

      // **The defect this assertion exists for was in the amendment's own first draft**: with four
      // states and no `onTrack`, a line finished before its finish date fell into Today. That
      // reports completed work as due — the mirror image of the problem the amendment set out to
      // fix. The line appears on the tree as `onTrack` and in none of the four groups.
      expect(alerts.today).toHaveLength(0);
      expect(alerts.delayed).toHaveLength(0);
      const tree = await service.getTree(CTX, 'project-1', TODAY);
      expect(tree[0].items[0].state).toBe('onTrack');
    });

    it('calls an overdue line with work outstanding delayed', async () => {
      const { service } = serviceWith([
        line({
          finishDate: day('2026-09-01'),
          startDate: day('2026-08-01'),
          doneQty: DEC('40'),
        }),
      ]);

      const alerts = await service.getAlerts(CTX, 'project-1', TODAY);

      expect(alerts.delayed).toHaveLength(1);
    });

    it('calls a line due today today', async () => {
      const { service } = serviceWith([
        line({
          finishDate: day('2026-10-03'),
          startDate: day('2026-09-01'),
          doneQty: DEC('10'),
        }),
      ]);

      const alerts = await service.getAlerts(CTX, 'project-1', TODAY);

      expect(alerts.today).toHaveLength(1);
    });

    it('honours perDayQty as an override where it is set', async () => {
      const { service } = serviceWith([
        line({
          finishDate: day('2026-12-31'),
          startDate: day('2026-09-01'),
          doneQty: DEC('10'),
          // Far above the derived rate, so this must be what decides — FR-047's override.
          perDayQty: DEC('50'),
        }),
      ]);

      const alerts = await service.getAlerts(CTX, 'project-1', TODAY);

      expect(alerts.toBeDelayed).toHaveLength(1);
    });
  });

  describe('the tree', () => {
    it('reports an unplanned programme column as null, never as zero', async () => {
      const { service } = serviceWith([line()]);

      const tree = await service.getTree(CTX, 'project-1', TODAY);

      // FR-037. A zero per-day target reads as "achieving nothing", which is a different claim
      // from "nobody has set a target".
      expect(tree[0].items[0].perDayQty).toBeNull();
      expect(tree[0].items[0].avgQtyPerDay).toBeNull();
      expect(tree[0].items[0].daysToComplete).toBeNull();
    });

    it('computes the pending quantity rather than storing it', async () => {
      const { service } = serviceWith([line({ doneQty: DEC('40') })]);

      const tree = await service.getTree(CTX, 'project-1', TODAY);

      expect(tree[0].items[0].pendingQty).toBe('60.000');
    });
  });

  describe('deleteItem', () => {
    it.each([
      [
        'a daily work report',
        { dwrTasks: 1, clientBillLines: 0, awardLines: 0 },
        'daily work report',
      ],
      [
        'a client bill line',
        { dwrTasks: 0, clientBillLines: 2, awardLines: 0 },
        'client bill',
      ],
      [
        'a work order award',
        { dwrTasks: 0, clientBillLines: 0, awardLines: 3 },
        'work order award',
      ],
    ])(
      'refuses when %s references the line',
      async (_name, counts, expected) => {
        const { service } = serviceWith([line()], counts);

        // Three relations, not one. Checking only the DWR — the obvious one, and the only one that
        // existed when US4 was written — would let a billed line be deleted out from under a
        // submitted bill.
        // `rejects.toThrow(RegExp)` rather than a `.catch` reading the message: a `.catch` whose
        // callback never runs passes silently, which is the shape this feature exists to prevent.
        await expect(
          service.deleteItem(CTX, 'project-1', 'item-1'),
        ).rejects.toThrow(ConflictException);
        await expect(
          service.deleteItem(CTX, 'project-1', 'item-1'),
        ).rejects.toThrow(new RegExp(expected));
      },
    );

    it('deletes a line nothing measures against', async () => {
      const { service, tx } = serviceWith([line()]);

      await service.deleteItem(CTX, 'project-1', 'item-1');

      expect(tx.bOQTaskItem.delete).toHaveBeenCalledWith({
        where: { id: 'item-1' },
      });
    });
  });
});
