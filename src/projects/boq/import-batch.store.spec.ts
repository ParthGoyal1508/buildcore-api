import { ImportBatchStore } from './import-batch.store';

const SEED = {
  companyId: 'company-1',
  userId: 'user-1',
  projectId: 'project-1',
  groups: [{ name: 'G', boqNo: '1', items: [] }],
  quotedPercentage: '0.024600',
};

describe('ImportBatchStore', () => {
  let store: ImportBatchStore;

  beforeEach(() => {
    store = new ImportBatchStore();
  });

  it('tells an expired batch apart from one that never existed', () => {
    const batch = store.create(SEED)!;
    store.ageForTesting(batch.id, 31);

    const found = store.lookup(batch.id);

    // FR-052, and the defect this file shipped in its first draft: deleting at the TTL made these
    // two indistinguishable. Somebody who read a 312-line report for ten minutes and then pressed
    // Confirm has to be told that it expired, not that their batch never existed.
    expect(found).toEqual({ batch: null, reason: 'expired' });
    expect(store.lookup('never-existed')).toEqual({
      batch: null,
      reason: 'not-found',
    });
  });

  it('drops an expired batch from memory at twice the TTL', () => {
    const batch = store.create(SEED)!;
    store.ageForTesting(batch.id, 61);

    // The explanation is worth keeping for a while and not forever; this is what bounds memory.
    expect(store.lookup(batch.id)).toEqual({
      batch: null,
      reason: 'not-found',
    });
  });

  it('claims a batch before its transaction and reports a concurrent confirm as in progress', () => {
    const batch = store.create(SEED)!;

    expect(store.claim(batch.id).batch).not.toBeNull();
    // FR-052: the second caller is told what is happening rather than being told nothing is.
    expect(store.lookup(batch.id)).toEqual({
      batch: null,
      reason: 'committing',
    });
  });

  it('returns a batch to ready when its transaction failed', () => {
    const batch = store.create(SEED)!;
    store.claim(batch.id);

    store.release(batch.id);

    // Nothing was written, so a retry is valid — and losing the batch here would mean re-uploading
    // and re-reading the whole report for a failure that was not the operator's.
    expect(store.lookup(batch.id).batch).not.toBeNull();
  });

  it('keeps a confirmed batch so a repeat can be explained', () => {
    const batch = store.create(SEED)!;
    store.claim(batch.id);
    store.markConfirmed(batch.id);

    // "Nothing happened" and "it already happened" are different facts needing different
    // sentences; deleting the batch would collapse them into one.
    expect(store.lookup(batch.id)).toEqual({
      batch: null,
      reason: 'confirmed',
    });
  });

  it('caps live batches per company, and a confirmed one does not count against the cap', () => {
    const live = Array.from({ length: 5 }, () => store.create(SEED)!);
    expect(store.create(SEED)).toBeNull();

    store.claim(live[0].id);
    store.markConfirmed(live[0].id);

    // A confirmed batch is a record kept for explanation, not a reservation on anybody's quota.
    expect(store.create(SEED)).not.toBeNull();
  });

  it('counts the cap per company, so one company cannot exhaust another', () => {
    Array.from({ length: 5 }, () => store.create(SEED));

    expect(store.create({ ...SEED, companyId: 'company-2' })).not.toBeNull();
  });

  it('never sweeps a batch that is inside its transaction', () => {
    const batch = store.create(SEED)!;
    store.claim(batch.id);
    store.ageForTesting(batch.id, 500);

    // Evicting it would lose the only record of a write in flight.
    expect(store.lookup(batch.id)).toEqual({
      batch: null,
      reason: 'committing',
    });
  });
});
