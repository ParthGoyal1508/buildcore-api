import { BadRequestException } from '@nestjs/common';
import { IndentStatus, Prisma } from '@prisma/client';

import { IndentFulfilmentService } from './indent-fulfilment.service';

const decimal = (n: number) => new Prisma.Decimal(n);

const line = (over: Record<string, unknown> = {}) => ({
  id: 'line-1',
  companyId: 'co-1',
  indentId: 'indent-1',
  requestedQuantity: decimal(100),
  approvedQuantity: decimal(80),
  fulfilledQuantity: decimal(0),
  indent: { id: 'indent-1', status: IndentStatus.approved, companyId: 'co-1' },
  ...over,
});

/**
 * A transaction double holding the indent's lines in memory, so "fulfil, then read
 * the outstanding quantity" is expressible rather than having to be asserted
 * against a call log.
 */
const build = (lines: ReturnType<typeof line>[]) => {
  const state = lines.map((row) => ({ ...row }));
  let indentStatus: IndentStatus =
    lines[0]?.indent.status ?? IndentStatus.approved;

  const tx = {
    materialIndentLine: {
      findUnique: jest.fn(async ({ where }: never) => {
        const w = where as { id: string };
        return state.find((row) => row.id === w.id) ?? null;
      }),
      update: jest.fn(async ({ where, data }: never) => {
        const w = where as { id: string };
        const d = data as {
          fulfilledQuantity: number | { increment: number };
        };
        const row = state.find((item) => item.id === w.id);
        if (!row) return null;
        const current = Number(row.fulfilledQuantity);
        row.fulfilledQuantity = decimal(
          typeof d.fulfilledQuantity === 'number'
            ? d.fulfilledQuantity
            : current + d.fulfilledQuantity.increment,
        );
        return row;
      }),
    },
    materialIndent: {
      findUnique: jest.fn(async () => ({ status: indentStatus, lines: state })),
      update: jest.fn(async ({ data }: never) => {
        indentStatus = (data as { status: IndentStatus }).status;
        return { status: indentStatus };
      }),
    },
  } as never;

  return { tx, state, status: () => indentStatus };
};

describe('IndentFulfilmentService (FR-023, FR-024)', () => {
  const service = new IndentFulfilmentService();

  it('books quantity against the line', async () => {
    const { tx, state } = build([line()]);
    await service.applyFulfilment(tx, {
      companyId: 'co-1',
      indentLineId: 'line-1',
      quantity: 30,
    });
    expect(Number(state[0].fulfilledQuantity)).toBe(30);
  });

  it('refuses more than the outstanding quantity, and says how much is left', async () => {
    const { tx } = build([line({ fulfilledQuantity: decimal(60) })]);
    const error = await service
      .applyFulfilment(tx, {
        companyId: 'co-1',
        indentLineId: 'line-1',
        quantity: 25,
      })
      .catch((e) => e);

    // 80 approved − 60 fulfilled = 20 outstanding.
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({ outstandingQuantity: 20 });
  });

  it('measures outstanding against the approved quantity, not the requested one', async () => {
    // Requested 100, approved 80. Issuing 90 must fail: the approver cut it.
    const { tx } = build([line()]);
    await expect(
      service.applyFulfilment(tx, {
        companyId: 'co-1',
        indentLineId: 'line-1',
        quantity: 90,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a line on an indent that has not been approved', async () => {
    const { tx } = build([
      line({
        indent: {
          id: 'indent-1',
          status: IndentStatus.submitted,
          companyId: 'co-1',
        },
      }),
    ]);
    await expect(
      service.applyFulfilment(tx, {
        companyId: 'co-1',
        indentLineId: 'line-1',
        quantity: 10,
      }),
    ).rejects.toThrow(/not approved/);
  });

  it('refuses a line belonging to another company', async () => {
    const { tx } = build([line()]);
    await expect(
      service.applyFulfilment(tx, {
        companyId: 'other-co',
        indentLineId: 'line-1',
        quantity: 10,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('advances the indent to partially_fulfilled on the first movement', async () => {
    const { tx, status } = build([line(), line({ id: 'line-2' })]);
    await service.applyFulfilment(tx, {
      companyId: 'co-1',
      indentLineId: 'line-1',
      quantity: 10,
    });
    expect(status()).toBe(IndentStatus.partially_fulfilled);
  });

  it('advances to fulfilled only once every line is met', async () => {
    const { tx, status } = build([
      line({ approvedQuantity: decimal(10) }),
      line({ id: 'line-2', approvedQuantity: decimal(5) }),
    ]);
    await service.applyFulfilment(tx, {
      companyId: 'co-1',
      indentLineId: 'line-1',
      quantity: 10,
    });
    expect(status()).toBe(IndentStatus.partially_fulfilled);

    await service.applyFulfilment(tx, {
      companyId: 'co-1',
      indentLineId: 'line-2',
      quantity: 5,
    });
    expect(status()).toBe(IndentStatus.fulfilled);
  });

  it('walks the status back down when a movement is reversed', async () => {
    const { tx, state, status } = build([
      line({ approvedQuantity: decimal(10) }),
    ]);
    await service.applyFulfilment(tx, {
      companyId: 'co-1',
      indentLineId: 'line-1',
      quantity: 10,
    });
    expect(status()).toBe(IndentStatus.fulfilled);

    await service.reverseFulfilment(tx, {
      indentLineId: 'line-1',
      quantity: 10,
    });
    expect(Number(state[0].fulfilledQuantity)).toBe(0);
    expect(status()).toBe(IndentStatus.approved);
  });

  it('floors a reversal at zero rather than letting outstanding exceed approved', async () => {
    const { tx, state } = build([line({ fulfilledQuantity: decimal(5) })]);
    await service.reverseFulfilment(tx, {
      indentLineId: 'line-1',
      quantity: 50,
    });
    expect(Number(state[0].fulfilledQuantity)).toBe(0);
  });

  it('leaves a rejected indent rejected, whatever the arithmetic says', async () => {
    const { tx, status } = build([
      line({
        indent: {
          id: 'indent-1',
          status: IndentStatus.rejected,
          companyId: 'co-1',
        },
      }),
    ]);
    await service.reverseFulfilment(tx, {
      indentLineId: 'line-1',
      quantity: 1,
    });
    expect(status()).toBe(IndentStatus.rejected);
  });

  it('keeps outstanding equal to approved minus fulfilled at every step (SC-A01)', async () => {
    const { tx, state } = build([line({ approvedQuantity: decimal(80) })]);
    for (const quantity of [10, 25, 15]) {
      await service.applyFulfilment(tx, {
        companyId: 'co-1',
        indentLineId: 'line-1',
        quantity,
      });
    }
    const fulfilled = Number(state[0].fulfilledQuantity);
    expect(fulfilled).toBe(50);
    expect(Number(state[0].approvedQuantity) - fulfilled).toBe(30);
  });
});
