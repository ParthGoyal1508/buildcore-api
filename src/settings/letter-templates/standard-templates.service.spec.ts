import { STANDARD_LETTER_TEMPLATES } from '../../letters/standard-letter-templates';
import { StandardTemplatesService } from './standard-templates.service';

/**
 * Installing the shipped letter bodies (2026-10-11).
 *
 * ## The failure worth a test
 *
 * **Reverting somebody's edit.** These are starting values, not managed content: a
 * company that rewrites its offer letter must keep the rewrite, and the installer runs
 * again on every company creation and on demand. An implementation that upserted the body
 * would pass "the template exists" and quietly restore the shipped wording of a legal
 * document the next time anybody touched the button. So the test asserts that a second
 * run creates **nothing**, and that the body already stored is untouched.
 *
 * Asserting only that six templates exist afterwards passes for exactly that bug.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const KINDS = STANDARD_LETTER_TEMPLATES.map((t, i) => ({
  id: `kind-${i}`,
  key: t.kindKey,
}));

function harness(opts: { existingFor?: string[] } = {}) {
  const existing = new Set(opts.existingFor ?? []);
  const kindIdByKey = new Map(KINDS.map((k) => [k.key, k.id]));

  const created: { letterKindId: string; bodyTemplate: string }[] = [];
  const fieldWrites: { letterKindId: string; token: string }[] = [];

  const tx: any = {
    letterKind: { findMany: jest.fn(async () => KINDS) },
    letterTemplate: {
      findFirst: jest.fn(async (args: any) => {
        const key = [...kindIdByKey].find(
          ([, id]) => id === args.where.letterKindId,
        )?.[0];
        return key && existing.has(key) ? { id: 'already-there' } : null;
      }),
      create: jest.fn(async (args: any) => {
        created.push(args.data);
        return args.data;
      }),
    },
    letterKindField: {
      upsert: jest.fn(async (args: any) => {
        fieldWrites.push(args.where.letterKindId_token);
        return args.create;
      }),
    },
  };
  return { service: new StandardTemplatesService(), tx, created, fieldWrites };
}

describe('StandardTemplatesService', () => {
  it('installs all six for a company that has none', async () => {
    const { service, tx, created } = harness();
    const result = await service.install('co-1', tx);

    expect(result.created.sort()).toEqual([
      'appointment',
      'experience',
      'increment',
      'offer',
      'payment_advice',
      'relieving',
    ]);
    // Active, or the settings screen shows a template that compose still refuses.
    expect(created.every((row: any) => row.isActive)).toBe(true);
  });

  it('creates nothing on a second run and leaves an edited body alone', async () => {
    // The whole point. The first run happens at company creation; this is every run
    // after it.
    const { service, tx, created } = harness({
      existingFor: STANDARD_LETTER_TEMPLATES.map((t) => t.kindKey),
    });
    const result = await service.install('co-1', tx);

    expect(result.created).toEqual([]);
    expect(created).toEqual([]);
    // No update call exists on the mock at all: if the service tried to write to an
    // existing row this would throw rather than quietly pass.
    expect(tx.letterTemplate.create).not.toHaveBeenCalled();
  });

  it('fills a gap without disturbing the kinds already present', async () => {
    // A company created before the increment letter shipped. It gets the new one and
    // keeps everything else exactly as it is.
    const { service, tx } = harness({
      existingFor: ['offer', 'appointment', 'relieving', 'experience'],
    });
    const result = await service.install('co-1', tx);

    expect(result.created.sort()).toEqual(['increment', 'payment_advice']);
    expect(result.skipped.sort()).toEqual([
      'appointment',
      'experience',
      'offer',
      'relieving',
    ]);
    void tx;
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

  it('declares fields even for a kind whose template already exists', async () => {
    // The skip is about the body, not the tokens. A company created before a token was
    // added to a kind still needs the declaration, or the compose screen will not ask
    // for it and the letter renders with a gap.
    const { service, tx, fieldWrites } = harness({
      existingFor: STANDARD_LETTER_TEMPLATES.map((t) => t.kindKey),
    });
    await service.install('co-1', tx);
    expect(fieldWrites.length).toBeGreaterThan(0);
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
});
