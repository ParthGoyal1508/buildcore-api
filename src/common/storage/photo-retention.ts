import { Logger } from '@nestjs/common';

import { StorageService } from './storage.service';

/** Rows handled per round trip; a backlog drains over several rounds in the same run. */
export const RETENTION_BATCH_SIZE = 500;
/** Rounds per table per run, so a huge first backlog cannot hold the job for an hour. */
export const RETENTION_MAX_BATCHES = 40;

export function daysAgo(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Deletes photos past their retention, batch by batch (057).
 *
 * `next` returns the oldest rows still holding a photo past the cutoff; `clear` nulls their refs.
 * The blobs go **first**: a blob whose row still points at it is retried tomorrow, whereas a row
 * cleared before its blob is deleted leaves an orphan nothing will ever find. Storage delete is
 * idempotent, so a retried blob is harmless.
 *
 * A blob that fails to delete keeps its ref and is retried on the next run — clearing it anyway
 * would trade a late deletion for no deletion.
 */
export async function sweepPhotos(
  storage: StorageService,
  logger: Logger,
  label: string,
  next: (take: number) => Promise<{ id: string; photoRef: string }[]>,
  clear: (rows: { id: string; photoRef: string }[]) => Promise<void>,
): Promise<number> {
  let total = 0;
  for (let round = 0; round < RETENTION_MAX_BATCHES; round += 1) {
    const rows = await next(RETENTION_BATCH_SIZE);
    if (rows.length === 0) break;
    const results = await Promise.allSettled(
      rows.map((row) => storage.delete(row.photoRef)),
    );
    const deleted = rows.filter((_, i) => results[i].status === 'fulfilled');
    if (deleted.length > 0) await clear(deleted);
    total += deleted.length;
    const failed = rows.length - deleted.length;
    if (failed > 0) {
      logger.warn(
        `${label}: ${failed} photo(s) could not be deleted; retrying next run.`,
      );
      // Every row failing means storage is down; another round would only repeat it.
      if (deleted.length === 0) break;
    }
    if (rows.length < RETENTION_BATCH_SIZE) break;
  }
  if (total > 0)
    logger.log(`${label}: deleted ${total} photo(s) past retention.`);
  return total;
}
