import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';

import config from '../../common/configs/config';

export type BatchState = 'ready' | 'committing' | 'confirmed' | 'expired';

export interface StagedGroup {
  name: string;
  boqNo: string;
  items: StagedItem[];
}

export interface StagedItem {
  boqNo: string;
  taskName: string;
  /** Exactly as the source spelled it (FR-041). */
  unit: string;
  scopeQty: string;
  rate: string;
  /** `scopeQty × rate`, computed here and never read from the file (FR-044). */
  amount: string;
  sourceRow: number;
}

export interface ImportBatch {
  id: string;
  state: BatchState;
  companyId: string;
  /** Who validated it. Only they may confirm it (FR-050). */
  userId: string;
  /** Which project it was validated for. Only that project may receive it (FR-050). */
  projectId: string;
  createdAt: Date;
  groups: StagedGroup[];
  /** Null where the workbook's `Excess (+)` could not be located — never 0 (FR-040). */
  quotedPercentage: string | null;
}

/** Why a batch is not available, which the caller turns into one of four sentences (FR-052). */
export type BatchUnavailable =
  | 'not-found'
  | 'expired'
  | 'committing'
  | 'confirmed';

/**
 * What `lookup` found.
 *
 * **A flat pair rather than a discriminated union, for a checked reason**: this project compiles
 * with `strictNullChecks: false` (tsconfig.json), under which narrowing a union on a boolean
 * discriminant does not work — `if (!found.found)` leaves `found.reason` inaccessible. Found by
 * writing it the other way first and reading the compiler error.
 */
export interface BatchLookup {
  /** Null when the batch cannot be used; `reason` then says why. */
  batch: ImportBatch | null;
  /** Null when `batch` is present. */
  reason: BatchUnavailable | null;
}

/**
 * Validated-but-unconfirmed import batches, in process memory (008 FR-052, FR-053; research §16).
 *
 * **Not a table, deliberately.** A batch exists to be reviewed and then discarded; the only cost
 * of losing one is re-uploading the file. A staged table — the shape 017 used for
 * `StagedProjectDocument` — would need an RLS policy, a sweep job and a retention answer for data
 * whose entire purpose is to be transient, and would leave unconfirmed client tender data at rest
 * for no benefit.
 *
 * **The trade-off, named rather than discovered**: a batch validated on one instance is invisible
 * to another, so this holds only while the API runs as a single instance, which it does today.
 * Scaling horizontally is the trigger to move batches into Postgres, and this note is here so the
 * symptom — intermittent `BOQ_BATCH_NOT_FOUND` under load — is diagnosable from the design rather
 * than from production.
 *
 * **A confirmed batch is kept, not deleted.** Deleting it would make a second confirm
 * indistinguishable from a bad identifier, and "nothing happened" and "it already happened" are
 * different facts that need different sentences (FR-052).
 */
@Injectable()
export class ImportBatchStore {
  private readonly batches = new Map<string, ImportBatch>();

  /**
   * @returns the new batch, or null when a cap is reached — refused rather than evicting a batch
   *   somebody is part-way through reading, which would present as their confirm failing for no
   *   stated reason (FR-053).
   */
  create(
    input: Omit<ImportBatch, 'id' | 'state' | 'createdAt'>,
  ): ImportBatch | null {
    this.sweep();
    const { maxLiveBatchesPerCompany, maxLiveBatchesTotal } =
      config().boqImport;
    // Only `ready` counts against the caps. An expired or confirmed batch is a record kept so a
    // repeat can be explained, not a reservation on anybody's quota.
    const live = [...this.batches.values()].filter(
      (batch) => batch.state === 'ready',
    );
    if (live.length >= maxLiveBatchesTotal) return null;
    if (
      live.filter((batch) => batch.companyId === input.companyId).length >=
      maxLiveBatchesPerCompany
    ) {
      return null;
    }

    const batch: ImportBatch = {
      ...input,
      id: randomUUID(),
      state: 'ready',
      createdAt: new Date(),
    };
    this.batches.set(batch.id, batch);
    return batch;
  }

  /** Reads a batch's situation without changing it. */
  lookup(id: string): BatchLookup {
    this.sweep();
    const batch = this.batches.get(id);
    if (!batch) return { batch: null, reason: 'not-found' };
    if (batch.state !== 'ready') return { batch: null, reason: batch.state };
    return { batch, reason: null };
  }

  /**
   * Moves a `ready` batch to `committing`, **synchronously**, before its transaction opens
   * (FR-052).
   *
   * The ordering is the whole point. Consuming the batch *after* the commit leaves a window where
   * a second confirm reads it as ready and writes the schedule twice; consuming it *before* loses
   * the schedule when the transaction fails, with nothing left to retry. Claiming it first and
   * releasing it on failure is the only ordering with neither failure, and it works because this
   * runs on one event loop: no second confirm can interleave between the read and the write below.
   */
  claim(id: string): BatchLookup {
    const found = this.lookup(id);
    if (!found.batch) return found;
    found.batch.state = 'committing';
    return found;
  }

  /** The transaction committed. Kept in `confirmed` so a repeat can be told what happened. */
  markConfirmed(id: string): void {
    const batch = this.batches.get(id);
    if (batch) batch.state = 'confirmed';
  }

  /** The transaction failed. Back to `ready`, because nothing was written and a retry is valid. */
  release(id: string): void {
    const batch = this.batches.get(id);
    if (batch && batch.state === 'committing') batch.state = 'ready';
  }

  /**
   * **Expires in two steps, and the first step is the point of it.**
   *
   * A batch past its TTL is marked `expired` and kept, not deleted — because somebody who spent
   * ten minutes reading a 312-line report and then pressed Confirm has to be told *that it
   * expired*, not that their batch never existed (FR-052). Deleting at the TTL made those two
   * indistinguishable, which was this file's first implementation and is the same class of defect
   * as the rest of this feature: a true statement the reader cannot act on.
   *
   * The row is dropped at twice the TTL, which is what bounds memory. By then nobody is still
   * holding the page open.
   */
  private sweep(): void {
    const ttl = config().boqImport.batchTtlMinutes * 60_000;
    const now = Date.now();
    for (const [id, batch] of this.batches) {
      // A batch mid-transaction is never swept, however long it has taken: evicting it would lose
      // the only record of a write in flight.
      if (batch.state === 'committing') continue;
      const age = now - batch.createdAt.getTime();
      if (age > ttl * 2) {
        this.batches.delete(id);
        continue;
      }
      if (age > ttl && batch.state === 'ready') batch.state = 'expired';
    }
  }

  /** Test seam only: the sweep is time-based and a unit test cannot wait thirty minutes. */
  ageForTesting(id: string, byMinutes: number): void {
    const batch = this.batches.get(id);
    if (batch)
      batch.createdAt = new Date(
        batch.createdAt.getTime() - byMinutes * 60_000,
      );
  }
}
