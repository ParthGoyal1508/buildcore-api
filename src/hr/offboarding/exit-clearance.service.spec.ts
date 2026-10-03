import { ExitClearanceService, CLEARANCE_KIND } from './exit-clearance.service';

/**
 * The derived exit clearance (021 T074-T078).
 *
 * The properties worth pinning are the ones a refactor would quietly break: that an allocation
 * with no custodian never appears, that a waiver does not discharge the underlying obligation,
 * that a bulk allocation reads as outstanding with its count stated, and that "could not ask" is
 * never reported as "nothing outstanding".
 */
describe('ExitClearanceService', () => {
  const build = (opts: {
    assets?: Record<string, unknown>[];
    kitRows?: Record<string, unknown>[];
    recoverableKitIds?: string[];
    advances?: Record<string, unknown>[];
    waivers?: Record<string, unknown>[];
    users?: Record<string, unknown>[];
    /** A pending proposal for the `approval.completed` handler to find (021 Phase 8). */
    proposal?: Record<string, unknown> | null;
    /** Open or refused proposals `forEmployee` should report, so a pending waiver reads as pending. */
    openProposals?: Record<string, unknown>[];
    /**
     * What the spine says about that proposal's instance — used both for the rejection path (T089)
     * and to name the countersigner (T090). Read through `ApprovalService`, never by querying the
     * spine's tables: `spine-boundary.spec.ts` refuses that, and refused the first version of this.
     */
    approvalState?: {
      state: string;
      latestDecision?: { actorUserId: string };
    } | null;
    noCustodySource?: boolean;
    /** Open **and** closed allocations, as the settlement summary asks for them. */
    custodyHistory?: Record<string, unknown>[];
  }) => {
    const waiverWrites: Record<string, unknown>[] = [];
    const proposalWrites: Record<string, unknown>[] = [];
    let livePending = opts.proposal != null;
    const tx = {
      $executeRaw: async () => 0,
      exitRecord: {
        findFirst: async () => ({ id: 'exit-1', employeeId: 'emp-1' }),
      },
      exitClearanceWaiver: {
        findMany: async () => opts.waivers ?? [],
        upsert: async (args: Record<string, unknown>) => {
          waiverWrites.push(args);
          return args;
        },
      },
      // 021 Phase 8. A proposal is what `waive()` writes now; the waiver itself is written by the
      // `approval.completed` handler.
      exitClearanceWaiverProposal: {
        create: async (args: Record<string, unknown>) => {
          // Stands in for the unique index on (item, status). Without this the double would admit
          // a second pending proposal that the database refuses, and the test asserting the
          // refusal would pass for the wrong reason — or, as it did first, fail.
          if (livePending) {
            throw Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
            });
          }
          proposalWrites.push(args);
          return { id: 'prop-1', ...(args.data as Record<string, unknown>) };
        },
        findFirst: async () => (livePending ? opts.proposal ?? null : null),
        // `forEmployee` reads open and refused proposals so the screen can show a pending waiver as
        // pending rather than as cleared (Phase 8).
        findMany: async () => opts.openProposals ?? [],
        updateMany: async () => {
          // What `settleStaleProposal` does to a proposal whose approval was rejected: it stops
          // being live, so the next `create` succeeds.
          livePending = false;
          return { count: 1 };
        },
      },
      onboardingItem: { findMany: async () => opts.kitRows ?? [] },
      kitItem: {
        findMany: async () =>
          (opts.recoverableKitIds ?? []).map((id) => ({ id })),
      },
      salaryAdvance: { findMany: async () => opts.advances ?? [] },
      // Waiver authors, for FR-016's "display its author". Defaults to empty so the
      // name falls back to the id — the case where the author's row has gone.
      user: { findMany: async () => opts.users ?? [] },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    // 021 Phase 8: `waive()` submits rather than writes. The double records the submission so a
    // test can assert on it, and returns a view shaped like the real one.
    const approvals = {
      submit: jest.fn(async () => ({ instanceId: 'inst-1', state: 'pending' })),
      // The spine raises no event for a rejection, so the proposal's status is reconciled against
      // it when somebody proposes again (T089).
      stateOfSystem: jest.fn(async () => opts.approvalState ?? null),
    };
    const registry = {
      source: () =>
        opts.noCustodySource
          ? null
          : {
              openCustodyFor: async () => opts.assets ?? [],
              // A different question from `openCustodyFor`, answered separately — see
              // `custodyOutcomesFor`. Defaults to the open set so an existing test that only
              // supplies `assets` still describes a consistent world.
              custodyHistoryFor: async () =>
                opts.custodyHistory ??
                (opts.assets ?? []).map((asset) => ({
                  ...asset,
                  status: 'open',
                  actualReturnDate: null,
                })),
            },
    };
    return {
      service: new ExitClearanceService(
        prisma as never,
        registry as never,
        approvals as never,
      ),
      waiverWrites,
      proposalWrites,
      approvals,
    };
  };

  const ctx = { isSuperAdmin: true } as never;

  /** Somebody who may propose a waiver — `PAYROLL`, the HR-office permission (T091). */
  const hrCaller = {
    id: 'u-1',
    companyId: 'co-1',
    permissions: ['PAYROLL'],
    grants: [],
  } as never;

  const allocation = (over: Record<string, unknown> = {}) => ({
    allocationId: 'alloc-1',
    assetId: 'a-1',
    assetName: 'Total Station',
    assetCode: 'AST-9',
    projectId: 'p-1',
    siteId: 'site-1',
    quantity: 1,
    expectedReturnDate: new Date('2026-10-01T00:00:00.000Z'),
    ...over,
  });

  it('lists an open asset allocation as outstanding', async () => {
    const { service } = build({ assets: [allocation()] });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');

    expect(clearance.items).toHaveLength(1);
    expect(clearance.items[0].kind).toBe(CLEARANCE_KIND.asset);
    expect(clearance.items[0].label).toContain('Total Station');
    expect(clearance.items[0].detail).toContain('site-1');
    expect(clearance.settleable).toBe(false);
  });

  it('states the quantity for a bulk allocation', async () => {
    // The asset register closes an allocation as a whole — it holds no partial return — so the
    // checklist reports the count rather than pretending some came back.
    const { service } = build({ assets: [allocation({ quantity: 10 })] });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');
    expect(clearance.items[0].detail).toContain('10 units');
  });

  it('is settleable once everything is returned', async () => {
    const { service } = build({ assets: [] });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');
    expect(clearance.items).toHaveLength(0);
    expect(clearance.settleable).toBe(true);
  });

  it('is settleable when an outstanding item is waived', async () => {
    const { service } = build({
      assets: [allocation()],
      waivers: [
        {
          itemKind: CLEARANCE_KIND.asset,
          itemRef: 'alloc-1',
          reason: 'Written off — asset lost on site',
          waivedByUserId: 'u-1',
          waivedAt: new Date(),
        },
      ],
    });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');

    // Still outstanding, and settleable anyway. The distinction matters: the asset did not come
    // back, and the summary must say so.
    expect(clearance.items[0].outstanding).toBe(true);
    expect(clearance.items[0].waiver?.reason).toContain('Written off');
    expect(clearance.settleable).toBe(true);
  });

  /**
   * 021 Phase 8, tasks T087 and T093.
   *
   * **The structural assertion, not a behavioural one.** A test that checked "the clearance is still
   * blocked" would pass while the waiver row was still being written by a path nobody looked at —
   * and a waiver that is both applied and awaiting approval is worse than either state, because the
   * settlement is already open while the Director's queue still shows a decision to make.
   */
  describe('proposing a waiver (FR-016, HR proposes and the Director countersigns)', () => {
    it('writes no waiver row at submission time', async () => {
      const { service, waiverWrites, proposalWrites } = build({
        assets: [allocation()],
      });

      await service.waive(
        ctx,
        'co-1',
        'emp-1',
        {
          kind: CLEARANCE_KIND.asset,
          ref: 'alloc-1',
          reason: 'Written off — asset lost on site',
        },
        hrCaller,
      );

      expect(waiverWrites).toEqual([]);
      expect(proposalWrites).toHaveLength(1);
    });

    it('submits to the approval spine', async () => {
      const { service, approvals } = build({ assets: [allocation()] });

      await service.waive(
        ctx,
        'co-1',
        'emp-1',
        {
          kind: CLEARANCE_KIND.asset,
          ref: 'alloc-1',
          reason: 'Written off — asset lost on site',
        },
        hrCaller,
      );

      expect(approvals.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'exit_clearance_waiver',
          entityId: 'prop-1',
          originatorUserId: 'u-1',
        }),
      );
    });

    it('returns the clearance still blocked', async () => {
      // The screen must not show the item waived. Returning a cleared clearance would be the
      // interface reporting a decision that has not been made.
      const { service } = build({ assets: [allocation()] });

      const { clearance } = await service.waive(
        ctx,
        'co-1',
        'emp-1',
        {
          kind: CLEARANCE_KIND.asset,
          ref: 'alloc-1',
          reason: 'Written off — asset lost on site',
        },
        hrCaller,
      );

      expect(clearance.settleable).toBe(false);
      expect(clearance.items[0].waiver).toBeNull();
    });

    it('refuses a caller who may not propose one (T091)', async () => {
      // Write access on employee records used to be enough. A write-off of company money is not
      // something a site administrator should be able to put in front of the Director alone.
      const { service, approvals } = build({ assets: [allocation()] });
      const siteAdmin = {
        id: 'u-2',
        companyId: 'co-1',
        permissions: ['EMPLOYEES'],
        grants: [],
      } as never;

      await expect(
        service.waive(
          ctx,
          'co-1',
          'emp-1',
          {
            kind: CLEARANCE_KIND.asset,
            ref: 'alloc-1',
            reason: 'Written off — asset lost on site',
          },
          siteAdmin,
        ),
      ).rejects.toThrow(/HR action/);
      // Refused before anything was submitted, so no item reaches the Director's queue.
      expect(approvals.submit).not.toHaveBeenCalled();
    });

    it('refuses a second proposal while one is pending', async () => {
      // Two pending items in the Director's queue for one decision is the failure the unique index
      // exists to prevent; this is the refusal the caller sees instead.
      const { service } = build({
        assets: [allocation()],
        proposal: { id: 'prop-0', companyId: 'co-1' },
        approvalState: { state: 'pending' },
      });

      await expect(
        service.waive(
          ctx,
          'co-1',
          'emp-1',
          {
            kind: CLEARANCE_KIND.asset,
            ref: 'alloc-1',
            reason: 'Trying again before the first was decided',
          },
          hrCaller,
        ),
      ).rejects.toThrow(/already waiting/);
    });

    it('lets HR propose again after a rejection (T089)', async () => {
      // A rejection leaves the obligation outstanding — nothing here writes a waiver — but it must
      // not leave HR unable to come back with a better reason. The spine raises no rejection event,
      // so the proposal's status is reconciled against the spine at this moment.
      const { service, approvals, waiverWrites } = build({
        assets: [allocation()],
        proposal: { id: 'prop-0', companyId: 'co-1' },
        approvalState: { state: 'rejected' },
      });

      await service.waive(
        ctx,
        'co-1',
        'emp-1',
        {
          kind: CLEARANCE_KIND.asset,
          ref: 'alloc-1',
          reason: 'Second attempt, with the police report attached',
        },
        hrCaller,
      );

      expect(approvals.submit).toHaveBeenCalled();
      // And still no waiver: the rejected one did not quietly clear the item on its way out.
      expect(waiverWrites).toEqual([]);
    });
  });

  describe('the screen can tell pending from cleared (T050, T051)', () => {
    it('reports a pending proposal without reporting a waiver', async () => {
      // The distinction the whole phase rests on. A screen that read a proposal as a waiver would
      // show an exit as clearable that is not.
      const { service } = build({
        assets: [allocation()],
        openProposals: [
          {
            itemKind: CLEARANCE_KIND.asset,
            itemRef: 'alloc-1',
            status: 'pending',
            reason: 'Written off — asset lost on site',
            proposedByUserId: 'u-1',
            proposedAt: new Date('2026-10-02T00:00:00.000Z'),
          },
        ],
      });

      const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');

      expect(clearance.items[0].waiver).toBeNull();
      expect(clearance.items[0].proposal).toMatchObject({ status: 'pending' });
      // And the item still blocks settlement, which is the consequence that matters.
      expect(clearance.settleable).toBe(false);
    });

    it('reports a rejected proposal rather than dropping it', async () => {
      // Silence after a rejection reads as success, and the person who asked needs to see the answer
      // was no.
      const { service } = build({
        assets: [allocation()],
        openProposals: [
          {
            itemKind: CLEARANCE_KIND.asset,
            itemRef: 'alloc-1',
            status: 'rejected',
            reason: 'Not enough evidence of the loss',
            proposedByUserId: 'u-1',
            proposedAt: new Date('2026-10-02T00:00:00.000Z'),
          },
        ],
      });

      const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');

      expect(clearance.items[0].proposal).toMatchObject({ status: 'rejected' });
      expect(clearance.settleable).toBe(false);
    });

    it('names the countersigner separately from the proposer', async () => {
      const { service } = build({
        assets: [allocation()],
        waivers: [
          {
            itemKind: CLEARANCE_KIND.asset,
            itemRef: 'alloc-1',
            reason: 'Written off',
            waivedByUserId: 'u-1',
            waivedAt: new Date('2026-10-02T00:00:00.000Z'),
            approvedByUserId: 'dir-1',
            approvedAt: new Date('2026-10-02T01:00:00.000Z'),
          },
        ],
        users: [
          { id: 'u-1', firstname: 'Asha', lastname: 'Pawar' },
          { id: 'dir-1', firstname: 'R', lastname: 'Director' },
        ],
      });

      const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');

      expect(clearance.items[0].waiver).toMatchObject({
        waivedByName: 'Asha Pawar',
        approvedByName: 'R Director',
      });
    });
  });

  describe('applying an approved waiver (T088, T089, T090)', () => {
    const proposal = {
      id: 'prop-1',
      companyId: 'co-1',
      exitRecordId: 'exit-1',
      itemKind: CLEARANCE_KIND.asset,
      itemRef: 'alloc-1',
      reason: 'Written off — asset lost on site',
      proposedByUserId: 'u-1',
      status: 'pending',
    };

    it('writes the waiver, with proposer and approver as separate facts', async () => {
      const { service, waiverWrites } = build({
        assets: [allocation()],
        proposal,
        approvalState: {
          state: 'approved',
          latestDecision: { actorUserId: 'dir-1' },
        },
      });

      await service.onApprovalCompleted({
        entityType: 'exit_clearance_waiver',
        entityId: 'prop-1',
        companyId: 'co-1',
        instanceId: 'inst-1',
      });

      expect(waiverWrites).toHaveLength(1);
      const created = (waiverWrites[0] as { create: Record<string, unknown> })
        .create;
      // T090. "HR waived this" and "HR asked and the Director agreed" are different facts, and
      // collapsing them loses the distinction the client's answer exists to create.
      expect(created.waivedByUserId).toBe('u-1');
      expect(created.approvedByUserId).toBe('dir-1');
    });

    it('writes no change to the allocation itself (FR-014c)', async () => {
      // The asset register owns custody: marking the allocation returned would put a false fact
      // in the table that holds the truth. A waiver says the company stopped chasing it.
      const { service, waiverWrites } = build({
        assets: [allocation()],
        proposal,
      });

      await service.onApprovalCompleted({
        entityType: 'exit_clearance_waiver',
        entityId: 'prop-1',
        companyId: 'co-1',
        instanceId: 'inst-1',
      });

      expect(waiverWrites).toHaveLength(1);
      expect(JSON.stringify(waiverWrites[0])).not.toContain('actualReturnDate');
      expect(JSON.stringify(waiverWrites[0])).not.toContain('closed');
    });

    it('ignores an event for another kind of item', async () => {
      const { service, waiverWrites } = build({
        assets: [allocation()],
        proposal,
      });

      await service.onApprovalCompleted({
        entityType: 'operator_fuel_recovery',
        entityId: 'prop-1',
        companyId: 'co-1',
        instanceId: 'inst-1',
      });

      expect(waiverWrites).toEqual([]);
    });

    it('is a no-op when no pending proposal matches', async () => {
      // T088's idempotence, and the rejection case in T089 reaching the same place: a proposal
      // that is already applied or already rejected is not pending, so a second delivery of the
      // event — which an event bus will do — writes nothing.
      const { service, waiverWrites } = build({
        assets: [allocation()],
        proposal: null,
      });

      await service.onApprovalCompleted({
        entityType: 'exit_clearance_waiver',
        entityId: 'prop-1',
        companyId: 'co-1',
        instanceId: 'inst-1',
      });

      expect(waiverWrites).toEqual([]);
    });
  });

  it('refuses a waiver for something not on the clearance', async () => {
    const { service } = build({ assets: [allocation()] });
    await expect(
      service.waive(
        ctx,
        'co-1',
        'emp-1',
        {
          kind: CLEARANCE_KIND.asset,
          ref: 'not-a-real-allocation',
          reason: 'Trying it on, at length',
        },
        hrCaller,
      ),
    ).rejects.toThrow();
  });

  it('lists only kit the company expects back', async () => {
    // A branded notebook is issued and never recovered. Listing it would make every exit look
    // incomplete, and the flag on `KitItem` is what says which is which.
    const { service } = build({
      assets: [],
      kitRows: [
        { id: 'oi-1', label: 'Laptop', kitItemId: 'kit-1' },
        { id: 'oi-2', label: 'Notebook', kitItemId: 'kit-2' },
      ],
      recoverableKitIds: ['kit-1'],
    });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');
    const kit = clearance.items.filter((i) => i.kind === CLEARANCE_KIND.kit);
    expect(kit).toHaveLength(1);
    expect(kit[0].label).toBe('Laptop');
  });

  it('lists an advance with a balance still owed', async () => {
    const { service } = build({
      assets: [],
      advances: [{ id: 'adv-1', outstandingBalance: '5000' }],
    });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');
    expect(clearance.items[0].kind).toBe(CLEARANCE_KIND.advance);
    expect(clearance.items[0].detail).toContain('5000');
  });

  it('never reports "could not ask" as "nothing outstanding"', async () => {
    // If feature 012 is not deployed, a clearance reporting no assets would be lying — and the
    // lie would let somebody leave with a laptop. So the source is named and settlement is
    // refused: the safe answer when part of the question went unanswered is "assume yes".
    const { service } = build({ noCustodySource: true });
    const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');

    expect(clearance.items).toHaveLength(0);
    expect(clearance.unavailableSources).toEqual(['asset_custody']);
    expect(clearance.settleable).toBe(false);
  });

  it('names every blocking item when it refuses a settlement', async () => {
    // A refusal saying only "something is outstanding" sends somebody hunting through a screen
    // they have already read.
    const { service } = build({ assets: [allocation()] });
    await expect(
      service.assertSettleable(ctx, 'co-1', 'emp-1'),
    ).rejects.toMatchObject({
      response: {
        code: 'EXIT_CLEARANCE_OUTSTANDING',
        blocking: [expect.stringContaining('Total Station')],
      },
    });
  });

  it('permits a settlement once nothing blocks it', async () => {
    const { service } = build({ assets: [] });
    await expect(
      service.assertSettleable(ctx, 'co-1', 'emp-1'),
    ).resolves.toBeUndefined();
  });

  describe('a waiver names its author (FR-016)', () => {
    it('resolves the author through the shared name chain', async () => {
      const { service } = build({
        assets: [allocation()],
        waivers: [
          {
            itemKind: CLEARANCE_KIND.asset,
            itemRef: 'alloc-1',
            reason: 'Written off — not worth pursuing',
            waivedByUserId: 'user-7',
            waivedAt: new Date('2026-09-30T00:00:00.000Z'),
          },
        ],
        users: [
          {
            id: 'user-7',
            displayName: null,
            firstname: 'Asha',
            lastname: 'Rao',
            username: 'asha',
            email: 'asha@example.com',
          },
        ],
      });

      const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');

      // Not the username and not the email: `actorNameOf` prefers a real name, and this
      // asserts the clearance uses that shared chain rather than picking a field itself —
      // the same actor must not appear under two names on two screens.
      expect(clearance.items[0].waiver?.waivedByName).toBe('Asha Rao');
    });

    it('falls back to the id when the author row has gone, never to a blank', async () => {
      const { service } = build({
        assets: [allocation()],
        waivers: [
          {
            itemKind: CLEARANCE_KIND.asset,
            itemRef: 'alloc-1',
            reason: 'Written off — not worth pursuing',
            waivedByUserId: 'user-gone',
            waivedAt: new Date('2026-09-30T00:00:00.000Z'),
          },
        ],
        users: [],
      });

      const clearance = await service.forEmployee(ctx, 'co-1', 'emp-1');

      // An unreadable identifier is more honest than a dash where a person belongs: the
      // decision was still made by somebody, and a blank invites the reader to conclude
      // nobody is accountable for it.
      expect(clearance.items[0].waiver?.waivedByName).toBe('user-gone');
    });
  });
});

/**
 * The settlement summary's asset list (021 FR-018a) — `bugs.md` item 10.
 *
 * ## The defect these pin
 *
 * `FnfService.settlementSummary` derived its asset list by filtering the clearance's items. The
 * clearance can only ever contain **open** custody, so an asset returned a week before the last
 * working day was absent from the settlement summary entirely — the summary said the employee had
 * never been given it. Against a client who asked, in their own words, for "any assets assigned to
 * the employee" to appear in the F&F summary.
 *
 * Nothing announced it. The summary rendered a shorter list that looked complete, and the only way
 * to notice was to know an asset had been returned and go looking for it.
 */
describe('ExitClearanceService.custodyOutcomesFor', () => {
  const ctx = { isSuperAdmin: true } as never;

  const build = (opts: {
    custodyHistory?: Record<string, unknown>[];
    waivers?: Record<string, unknown>[];
    users?: Record<string, unknown>[];
    noCustodySource?: boolean;
  }) => {
    const tx = {
      $executeRaw: async () => 0,
      exitRecord: { findFirst: async () => ({ id: 'exit-1' }) },
      exitClearanceWaiver: { findMany: async () => opts.waivers ?? [] },
      user: { findMany: async () => opts.users ?? [] },
    };
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const registry = {
      source: () =>
        opts.noCustodySource
          ? null
          : { custodyHistoryFor: async () => opts.custodyHistory ?? [] },
    };
    return new ExitClearanceService(
      prisma as never,
      registry as never,
      { submit: jest.fn(), stateOfSystem: jest.fn() } as never,
    );
  };

  const record = (over: Record<string, unknown> = {}) => ({
    allocationId: 'alloc-1',
    assetId: 'a-1',
    assetName: 'Total Station',
    assetCode: 'AST-9',
    projectId: 'p-1',
    siteId: 'site-1',
    quantity: 1,
    expectedReturnDate: new Date('2026-10-01T00:00:00.000Z'),
    status: 'open',
    actualReturnDate: null,
    ...over,
  });

  it('keeps an asset that was returned, which the clearance correctly drops', async () => {
    // The whole of the defect. This allocation is closed, so it is absent from the clearance — and
    // it must still be on the settlement summary, marked returned, with the date.
    const service = build({
      custodyHistory: [
        record({
          status: 'closed',
          actualReturnDate: new Date('2026-09-24T00:00:00.000Z'),
        }),
      ],
    });

    const { assets } = await service.custodyOutcomesFor(ctx, 'co-1', 'emp-1');

    expect(assets).toHaveLength(1);
    expect(assets?.[0].outcome).toBe('returned');
    expect(assets?.[0].returnedOn).toBe('2026-09-24');
    expect(assets?.[0].label).toContain('Total Station');
  });

  it('marks a still-held asset outstanding, with no return date', async () => {
    const service = build({ custodyHistory: [record()] });

    const { assets } = await service.custodyOutcomesFor(ctx, 'co-1', 'emp-1');

    expect(assets?.[0].outcome).toBe('outstanding');
    expect(assets?.[0].returnedOn).toBeNull();
    expect(assets?.[0].waivedByName).toBeNull();
  });

  it('names the person who waived one, and their reason', async () => {
    const service = build({
      custodyHistory: [record()],
      waivers: [
        {
          itemKind: 'asset_custody',
          itemRef: 'alloc-1',
          reason: 'Lost on site; recovered from the final payment by agreement',
          waivedByUserId: 'u-9',
        },
      ],
      users: [{ id: 'u-9', firstname: 'Asha', lastname: 'Menon' }],
    });

    const { assets } = await service.custodyOutcomesFor(ctx, 'co-1', 'emp-1');

    // FR-016's requirement, carried onto the summary: a write-off of company money shows whose
    // decision it was.
    expect(assets?.[0].outcome).toBe('waived');
    expect(assets?.[0].waivedByName).toBe('Asha Menon');
    expect(assets?.[0].waiverReason).toMatch(
      /recovered from the final payment/,
    );
  });

  it('prefers "waived" over "returned" when a closed allocation carries a waiver', async () => {
    // Different facts about where the asset is. A closed allocation with a waiver against it is an
    // asset somebody wrote off, not one that came back — and the summary is the record of which.
    const service = build({
      custodyHistory: [
        record({
          status: 'closed',
          actualReturnDate: new Date('2026-09-24T00:00:00.000Z'),
        }),
      ],
      waivers: [
        {
          itemKind: 'asset_custody',
          itemRef: 'alloc-1',
          reason: 'Written off',
          waivedByUserId: 'u-9',
        },
      ],
    });

    const { assets } = await service.custodyOutcomesFor(ctx, 'co-1', 'emp-1');
    expect(assets?.[0].outcome).toBe('waived');
  });

  it('falls back to the user id when the waiver author’s row has gone', async () => {
    const service = build({
      custodyHistory: [record()],
      waivers: [
        {
          itemKind: 'asset_custody',
          itemRef: 'alloc-1',
          reason: 'Written off',
          waivedByUserId: 'u-deleted',
        },
      ],
      users: [],
    });

    const { assets } = await service.custodyOutcomesFor(ctx, 'co-1', 'emp-1');
    // An unreadable identifier is more honest than a dash where a person belongs.
    expect(assets?.[0].waivedByName).toBe('u-deleted');
  });

  it('returns null, not an empty list, when the asset module is not deployed', async () => {
    const service = build({ noCustodySource: true });

    const { assets } = await service.custodyOutcomesFor(ctx, 'co-1', 'emp-1');

    // "Could not ask" and "held nothing" are different facts, and a settlement is signed off on
    // them. The same decision `forEmployee` makes with `unavailableSources`.
    expect(assets).toBeNull();
  });

  it('reports an employee who held nothing as an empty list, which is not null', async () => {
    const service = build({ custodyHistory: [] });

    const { assets } = await service.custodyOutcomesFor(ctx, 'co-1', 'emp-1');
    expect(assets).toEqual([]);
  });
});
