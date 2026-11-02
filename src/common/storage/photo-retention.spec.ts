import { Logger } from '@nestjs/common';

import { RETENTION_BATCH_SIZE, daysAgo, sweepPhotos } from './photo-retention';

/** 057: the retention sweep deletes blobs first and clears only what it deleted. */
describe('sweepPhotos', () => {
  const logger = { log: jest.fn(), warn: jest.fn() } as unknown as Logger;

  /** A table of rows holding photos; `next` hands out the ones still holding a ref. */
  function table(count: number) {
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `r${i}`,
      photoRef: `p/${i}` as string | null,
    }));
    return {
      rows,
      next: async (take: number) =>
        rows.filter((r) => r.photoRef !== null).slice(0, take) as {
          id: string;
          photoRef: string;
        }[],
      clear: async (done: { id: string }[]) => {
        for (const d of done) rows.find((r) => r.id === d.id)!.photoRef = null;
      },
    };
  }

  it('deletes every photo past retention and clears its ref', async () => {
    const t = table(3);
    const deleted: string[] = [];
    const storage = { delete: async (ref: string) => void deleted.push(ref) };

    const total = await sweepPhotos(
      storage as never,
      logger,
      'x',
      t.next,
      t.clear,
    );

    expect(total).toBe(3);
    expect(deleted).toEqual(['p/0', 'p/1', 'p/2']);
    expect(t.rows.every((r) => r.photoRef === null)).toBe(true);
  });

  it('keeps the ref of a photo it could not delete, to retry next run', async () => {
    const t = table(2);
    const storage = {
      delete: async (ref: string) => {
        if (ref === 'p/1') throw new Error('storage hiccup');
      },
    };

    const total = await sweepPhotos(
      storage as never,
      logger,
      'x',
      t.next,
      t.clear,
    );

    expect(total).toBe(1);
    expect(t.rows[0].photoRef).toBeNull();
    // Cleared before its blob was gone, it would be an orphan nothing could find again.
    expect(t.rows[1].photoRef).toBe('p/1');
  });

  it('stops at once when storage is down rather than looping', async () => {
    const t = table(RETENTION_BATCH_SIZE * 2);
    const storage = {
      delete: jest.fn(async () => {
        throw new Error('down');
      }),
    };

    await sweepPhotos(storage as never, logger, 'x', t.next, t.clear);

    expect(storage.delete).toHaveBeenCalledTimes(RETENTION_BATCH_SIZE);
  });

  it('drains a backlog larger than one batch', async () => {
    const t = table(RETENTION_BATCH_SIZE + 7);
    const storage = { delete: async () => undefined };

    const total = await sweepPhotos(
      storage as never,
      logger,
      'x',
      t.next,
      t.clear,
    );

    expect(total).toBe(RETENTION_BATCH_SIZE + 7);
  });

  it('counts days back from now', () => {
    const now = new Date('2026-11-15T00:00:00Z');
    expect(daysAgo(14, now).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});
