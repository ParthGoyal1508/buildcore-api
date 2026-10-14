import { STANDARD_LETTER_TEMPLATES } from '../../letters/standard-letter-templates';
import { StandardTemplatesService } from './standard-templates.service';

/**
 * Installing — and keeping — the shipped letter bodies (2026-10-11, rule changed 2026-10-14).
 *
 * ## The failures worth a test
 *
 * The standard wording is the same for every company, so a company's copy of a shipped kind's
 * template must match the code. Two ways to get that wrong:
 *
 * - **Leaving stale wording in place.** A company created before a body changed keeps printing
 *   the old letter. So a differing body (or name) must be rewritten — every row of the kind, not
 *   just the active one.
 * - **Writing when nothing changed.** This runs on every start for every company; an
 *   implementation that rewrote matching rows would bump `updatedAt` on every template on every
 *   deploy and make "what changed" unanswerable. So a run over matching rows writes nothing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const KINDS = STANDARD_LETTER_TEMPLATES.map((t, i) => ({
  id: `kind-${i}`,
  key: t.kindKey,
}));

type Row = { id: string; name: string; bodyTemplate: string };

function harness(
  opts: {
    /** Kind keys with a template already matching the standard wording. */
    existingFor?: string[];
    /** Kind keys with rows of their own, as given. */
    rowsFor?: Record<string, Row[]>;
    existingFields?: Record<string, unknown>[];
  } = {},
) {
  const kindIdByKey = new Map(KINDS.map((k) => [k.key, k.id]));
  const rowsByKey: Record<string, Row[]> = { ...(opts.rowsFor ?? {}) };
  for (const key of opts.existingFor ?? []) {
    const standard = STANDARD_LETTER_TEMPLATES.find((t) => t.kindKey === key)!;
    rowsByKey[key] = [
      { id: `tpl-${key}`, name: standard.name, bodyTemplate: standard.body },
    ];
  }

  const created: { letterKindId: string; bodyTemplate: string }[] = [];
  const fieldWrites: { letterKindId: string; token: string }[] = [];

  const tx: any = {
    letterKind: { findMany: jest.fn(async () => KINDS) },
    company: {
      findMany: jest.fn(async () => [{ id: 'co-1', shortCode: 'PRPL' }]),
    },
    letterTemplate: {
      updateMany: jest.fn(async (args: any) => ({
        count: args.where.id.in.length,
      })),
      findMany: jest.fn(async (args: any) => {
        const key = [...kindIdByKey].find(
          ([, id]) => id === args.where.letterKindId,
        )?.[0];
        return (key && rowsByKey[key]) || [];
      }),
      create: jest.fn(async (args: any) => {
        created.push(args.data);
        return args.data;
      }),
    },
    letterKindField: {
      findMany: jest.fn(async () => opts.existingFields ?? []),
      upsert: jest.fn(async (args: any) => {
        fieldWrites.push(args.where.letterKindId_token);
        return args.create;
      }),
      deleteMany: jest.fn(async (args: any) => ({
        count: args.where.token.in.length,
      })),
    },
  };
  return {
    service: new StandardTemplatesService({} as any),
    tx,
    created,
    fieldWrites,
  };
}

const ALL_KEYS = STANDARD_LETTER_TEMPLATES.map((t) => t.kindKey).sort();

describe('StandardTemplatesService', () => {
  it('installs every standard template for a company that has none', async () => {
    const { service, tx, created } = harness();
    const result = await service.install('co-1', tx);

    expect(result.created.sort()).toEqual([
      'appointment',
      'experience',
      'fnf_settlement',
      'increment',
      'offer',
      'payment_advice',
      'relieving',
      'termination',
      'transfer',
    ]);
    // Active, or the settings screen shows a template that compose still refuses.
    expect(created.every((row: any) => row.isActive)).toBe(true);
  });

  it('writes nothing when every template already has the standard wording', async () => {
    // Every start after the first, for every company.
    const { service, tx } = harness({ existingFor: ALL_KEYS });
    const result = await service.install('co-1', tx);

    expect(result.created).toEqual([]);
    expect(result.replaced).toEqual([]);
    expect(result.skipped.sort()).toEqual(ALL_KEYS);
    expect(tx.letterTemplate.create).not.toHaveBeenCalled();
    expect(tx.letterTemplate.updateMany).not.toHaveBeenCalled();
  });

  it('brings an edited body and a renamed copy back to the standard wording', async () => {
    const offer = STANDARD_LETTER_TEMPLATES.find((t) => t.kindKey === 'offer')!;
    const { service, tx } = harness({
      existingFor: ALL_KEYS.filter((k) => k !== 'offer'),
      rowsFor: {
        offer: [
          // The active one, rewritten by the company.
          { id: 'a', name: offer.name, bodyTemplate: 'Our own offer.' },
          // An old placeholder, inactive — one toggle away from going out.
          { id: 'b', name: 'Offer (old)', bodyTemplate: offer.body },
          // Already right; not written.
          { id: 'c', name: offer.name, bodyTemplate: offer.body },
        ],
      },
    });
    const result = await service.install('co-1', tx);

    expect(result.replaced).toEqual(['offer']);
    expect(tx.letterTemplate.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.letterTemplate.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b'] } },
      // Only the wording: whether it is active, and its letterhead, stay the company's.
      data: { name: offer.name, bodyTemplate: offer.body },
    });
  });

  it('fills a gap and leaves the kinds already standard alone', async () => {
    const { service, tx } = harness({
      existingFor: ['offer', 'appointment', 'relieving', 'experience'],
    });
    const result = await service.install('co-1', tx);

    expect(result.created.sort()).toEqual([
      'fnf_settlement',
      'increment',
      'payment_advice',
      'termination',
      'transfer',
    ]);
    expect(result.skipped.sort()).toEqual([
      'appointment',
      'experience',
      'offer',
      'relieving',
    ]);
  });

  it('only touches templates of shipped kinds that have a standard template', async () => {
    // Company-defined kinds (and shipped kinds with no standard body) are never queried, so
    // they cannot be written.
    const { service, tx } = harness();
    await service.install('co-1', tx);
    expect(tx.letterKind.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: { in: expect.any(Array) }, companyId: null },
      }),
    );
    const queriedKindIds = tx.letterTemplate.findMany.mock.calls.map(
      (c: any) => c[0].where.letterKindId,
    );
    expect(new Set(queriedKindIds)).toEqual(new Set(KINDS.map((k) => k.id)));
  });

  it('declares every token of every kind, so the compose screen asks for them', async () => {
    const { service, tx, fieldWrites } = harness();
    await service.install('co-1', tx);

    const expected = STANDARD_LETTER_TEMPLATES.reduce(
      (n, t) => n + t.fields.length,
      0,
    );
    // A token never declared is never asked for, and `renderTemplate` substitutes it
    // with an empty string — a blank in a signed letter, indistinguishable from a
    // deliberate omission.
    expect(fieldWrites).toHaveLength(expected);
  });

  it('skips a kind the database has never heard of rather than failing creation', async () => {
    // A migration that has not run yet. A company starting without one letter is a
    // better outcome than company creation throwing.
    const { service, tx } = harness();
    tx.letterKind.findMany = jest.fn(async () => [
      { id: 'kind-offer', key: 'offer' },
    ]);
    const result = await service.install('co-1', tx);

    expect(result.created).toEqual(['offer']);
    expect(result.skipped).toContain('payment_advice');
  });

  describe('on application start (2026-10-14)', () => {
    function bootPrisma(tx: any) {
      return {
        $transaction: jest.fn(async (fn: (t: unknown) => unknown) =>
          fn({ ...tx, $executeRaw: jest.fn() }),
        ),
      } as any;
    }

    it("brings every company's templates up to the code, one transaction each", async () => {
      const { tx } = harness();
      tx.company.findMany = jest.fn(async () => [
        { id: 'co-1', shortCode: 'PRPL' },
        { id: 'co-2', shortCode: 'ACME' },
      ]);
      const prisma = bootPrisma(tx);
      const service = new StandardTemplatesService(prisma);
      const log = jest
        .spyOn((service as any).logger, 'log')
        .mockImplementation(() => undefined);
      await service.onApplicationBootstrap();

      // One for the shared field declarations, then one per company.
      expect(prisma.$transaction).toHaveBeenCalledTimes(3);
      const companies = tx.letterTemplate.create.mock.calls.map(
        (c: any) => c[0].data.companyId,
      );
      expect(new Set(companies)).toEqual(new Set(['co-1', 'co-2']));
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Standard letter templates for PRPL: created'),
      );
    });

    it('logs nothing about templates when nothing changed', async () => {
      const { tx } = harness({ existingFor: ALL_KEYS });
      const service = new StandardTemplatesService(bootPrisma(tx));
      const log = jest
        .spyOn((service as any).logger, 'log')
        .mockImplementation(() => undefined);
      await service.onApplicationBootstrap();

      expect(tx.letterTemplate.updateMany).not.toHaveBeenCalled();
      expect(tx.letterTemplate.create).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalledWith(
        expect.stringContaining('Standard letter templates'),
      );
    });

    it('carries on with the next company when one fails', async () => {
      const { tx } = harness();
      tx.company.findMany = jest.fn(async () => [
        { id: 'co-bad', shortCode: 'BAD' },
        { id: 'co-2', shortCode: 'ACME' },
      ]);
      const create = tx.letterTemplate.create;
      tx.letterTemplate.create = jest.fn(async (args: any) => {
        if (args.data.companyId === 'co-bad') throw new Error('boom');
        return create(args);
      });
      const service = new StandardTemplatesService(bootPrisma(tx));
      const warn = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);
      jest
        .spyOn((service as any).logger, 'log')
        .mockImplementation(() => undefined);

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('BAD'));
      expect(
        tx.letterTemplate.create.mock.calls.some(
          (c: any) => c[0].data.companyId === 'co-2',
        ),
      ).toBe(true);
    });
  });

  describe('keeping shipped field declarations in step with the code (2026-10-13)', () => {
    const offer = STANDARD_LETTER_TEMPLATES.find((t) => t.kindKey === 'offer')!;
    const offerKindId = KINDS.find((k) => k.key === 'offer')!.id;
    const asRows = (kindId: string, fields: typeof offer.fields) =>
      fields.map((f) => ({ letterKindId: kindId, ...f }));
    const everyKindAsDeclared = () =>
      STANDARD_LETTER_TEMPLATES.flatMap((t) =>
        asRows(KINDS.find((k) => k.key === t.kindKey)!.id, t.fields),
      );

    it('writes nothing when every declaration already matches', async () => {
      // The restart case: two reads, no writes.
      const { service, tx } = harness({
        existingFields: everyKindAsDeclared(),
      });
      const changed = await service.syncShippedFields(tx);

      expect(changed).toBe(0);
      expect(tx.letterKindField.upsert).not.toHaveBeenCalled();
      expect(tx.letterKindField.deleteMany).not.toHaveBeenCalled();
    });

    it('overwrites a path the previous release declared differently', async () => {
      // The defect this replaced: `update: {}` kept `designation.name` forever, and the
      // record pre-fill reads `designation`, so every existing database printed a blank.
      const rows = everyKindAsDeclared().map((row) =>
        row.letterKindId === offerKindId && row.token === offer.fields[0].token
          ? { ...row, sourcePath: 'stale.path', label: 'Old label' }
          : row,
      );
      const { service, tx } = harness({ existingFields: rows });
      const changed = await service.syncShippedFields(tx);

      expect(changed).toBe(1);
      expect(tx.letterKindField.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            letterKindId_token: {
              letterKindId: offerKindId,
              token: offer.fields[0].token,
            },
          },
          update: expect.objectContaining({
            label: offer.fields[0].label,
            sourcePath: offer.fields[0].sourcePath,
          }),
        }),
      );
    });

    it('removes a token the shipped template no longer declares', async () => {
      const rows = [
        ...everyKindAsDeclared(),
        {
          letterKindId: offerKindId,
          token: 'retiredToken',
          label: 'Retired',
          sourceType: 'manual',
          sourcePath: null,
          isRequired: false,
        },
      ];
      const { service, tx } = harness({ existingFields: rows });
      const changed = await service.syncShippedFields(tx);

      expect(changed).toBe(1);
      expect(tx.letterKindField.deleteMany).toHaveBeenCalledWith({
        where: { letterKindId: offerKindId, token: { in: ['retiredToken'] } },
      });
    });

    it('runs on application start, under the RLS bypass shipped rows need', async () => {
      const { tx } = harness();
      const prisma: any = {
        $transaction: jest.fn(async (fn: (t: unknown) => unknown) =>
          fn({ ...tx, $executeRaw: jest.fn() }),
        ),
      };
      const service = new StandardTemplatesService(prisma);
      await service.onApplicationBootstrap();

      // The declarations once, then the harness's one company's templates.
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(tx.letterKindField.upsert).toHaveBeenCalled();
    });

    it('does not stop the application from starting when the sync fails', async () => {
      const prisma: any = {
        $transaction: jest.fn(async () => {
          throw new Error('relation does not exist');
        }),
      };
      await expect(
        new StandardTemplatesService(prisma).onApplicationBootstrap(),
      ).resolves.toBeUndefined();
    });
  });
});
