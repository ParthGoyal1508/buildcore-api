import { BadRequestException, ConflictException } from '@nestjs/common';

import { LetterKindsService } from './letter-kinds.service';

const COMPANY = 'co-1';
const ctx = { isSuperAdmin: false, companyId: COMPANY };

type Row = {
  id: string;
  companyId: string | null;
  key: string;
  label: string;
  requiresSignature: boolean;
  requiresApproval: boolean;
  approvalActionType: string | null;
  isActive: boolean;
};

const shipped = (key: string): Row => ({
  id: `ltrkind_${key}`,
  companyId: null,
  key,
  label: key,
  requiresSignature: false,
  requiresApproval: false,
  approvalActionType: null,
  isActive: true,
});

function harness(rows: Row[] = []) {
  const calls: string[] = [];
  const tx = {
    letterKind: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        calls.push('letterKind.findFirst');
        const where = args.where as {
          key?: string;
          id?: string;
          companyId?: string | null;
        };
        return (
          rows.find(
            (r) =>
              (where.key === undefined || r.key === where.key) &&
              (where.id === undefined || r.id === where.id) &&
              (where.companyId === undefined ||
                r.companyId === where.companyId),
          ) ?? null
        );
      }),
      findMany: jest.fn(async () => {
        calls.push('letterKind.findMany');
        return rows;
      }),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        calls.push('letterKind.create');
        return { ...shipped('x'), ...args.data, id: 'new-1' };
      }),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        calls.push('letterKind.update');
        return { ...rows[0], ...args.data };
      }),
      delete: jest.fn(async () => {
        calls.push('letterKind.delete');
        return rows[0];
      }),
    },
    $executeRaw: jest.fn(),
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const audit: any = { record: jest.fn().mockResolvedValue(undefined) };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { service: new LetterKindsService(prisma, audit), calls, tx };
}

const actor = { userId: 'u-1', ipAddress: '10.0.0.1' };

describe('LetterKindsService (T026b, FR-011, FR-011a, FR-022)', () => {
  it('refuses a company kind that reuses a product-shipped key', async () => {
    const { service, tx } = harness([shipped('offer')]);

    const error = await service
      .create(ctx, COMPANY, { key: 'offer', label: 'Our offer' }, actor)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as { response: { code: string } }).response.code).toBe(
      'LETTER_KIND_KEY_RESERVED',
    );
    // Nothing written. Two kinds answering to one key leave every lookup ambiguous —
    // and the place that surfaces is a letter issued from the wrong template.
    expect(tx.letterKind.create).not.toHaveBeenCalled();
  });

  it('allows a key the product does not ship', async () => {
    const { service, tx } = harness([shipped('offer')]);

    await service.create(
      ctx,
      COMPANY,
      { key: 'site_transfer', label: 'Site transfer' },
      actor,
    );

    expect(tx.letterKind.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyId: COMPANY,
          key: 'site_transfer',
        }),
      }),
    );
  });

  it('refuses a kind that requires approval but names nothing to gate on', async () => {
    const { service } = harness([]);

    const error = await service
      .create(
        ctx,
        COMPANY,
        { key: 'big_spend', label: 'Big spend', requiresApproval: true },
        actor,
      )
      .catch((e: unknown) => e);

    // It would look gated and be gated on nothing: `assertMayTakeEffect` with an empty
    // action type is not in the director-final list, so it passes.
    expect(error).toBeInstanceOf(BadRequestException);
  });

  it('refuses to edit or delete a product-shipped kind', async () => {
    const { service } = harness([shipped('offer')]);

    const edit = await service
      .update(ctx, COMPANY, 'ltrkind_offer', { label: 'Mine' }, actor)
      .catch((e: unknown) => e);
    const remove = await service
      .remove(ctx, COMPANY, 'ltrkind_offer', actor)
      .catch((e: unknown) => e);

    // Other companies use the same row. Editing it would rename their letter kind.
    expect(edit).toBeInstanceOf(ConflictException);
    expect(remove).toBeInstanceOf(ConflictException);
  });

  it('translates the foreign-key refusal into LETTER_KIND_IN_USE (FR-022)', async () => {
    const own: Row = { ...shipped('site_transfer'), companyId: COMPANY };
    const { service, tx } = harness([own]);
    tx.letterKind.delete = jest.fn(async () => {
      throw Object.assign(new Error('FK violation'), { code: 'P2003' });
    });

    const error = await service
      .remove(ctx, COMPANY, own.id, actor)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as { response: { code: string } }).response.code).toBe(
      'LETTER_KIND_IN_USE',
    );
  });

  it('resolves a key against the company AND the shipped set in one lookup', async () => {
    const { service, calls } = harness([shipped('offer')]);

    const kind = await service.findByKey(ctx, COMPANY, 'offer');

    // One query, not "try mine then try shipped". At most one row can match, which is a
    // guarantee (FR-011a plus the partial unique index), not an observation.
    expect(kind?.key).toBe('offer');
    expect(calls).toEqual(['letterKind.findFirst']);
  });
});
