import { applyDecorators, Injectable, SetMetadata } from '@nestjs/common';

export const APPROVAL_RECONCILER_METADATA = 'approvals:reconciler';

/** What a module reports back about one of its items (016 T052). */
export interface ReconciledItem {
  /** The item's own id, as the spine stores it in `ApprovalInstance.entityId`. */
  entityId: string;
  /**
   * Whether the item still exists in the owning module.
   *
   * False is the **orphan** case research.md §1 names as the price of having no foreign
   * key: an approval pointing at a record that has been deleted.
   */
  exists: boolean;
  /**
   * Whether the module's own status agrees with the spine's.
   *
   * `ApprovalInstance.state` is the source of truth (research.md §8); a module's status
   * column is a derived convenience. False here is **drift** — the module's second write
   * failed or was never made — and it is repairable by replay, which is why the sweep
   * reports it rather than agonising over it.
   *
   * Null when the module has no opinion, which is honest and different from `true`.
   */
  inStep: boolean | null;
}

/**
 * A module's answer to "are your items still there, and do they agree with me?".
 *
 * The spine cannot answer either question. It stores `(entityType, entityId)` and never
 * dereferences it — that opacity is research.md §1 and the reason Principle I holds across
 * seven schemas. So the owning module answers, through its own service, and the sweep asks.
 */
export interface ApprovalReconciler {
  /** The `entityType` this reconciler speaks for. One reconciler per type. */
  readonly entityType: string;
  /**
   * Given the ids of live instances for this company, report each one.
   *
   * Batched rather than one call per item, for the same reason `statesOf` exists: the
   * sweep runs over every live approval in the product, and a per-item round trip would
   * make it quadratic in the thing it is meant to keep cheap.
   */
  reconcile(
    companyId: string,
    entityIds: string[],
    spineStates: Map<string, string>,
  ): Promise<ReconciledItem[]>;
}

/**
 * Marks a provider as the reconciler for one `entityType`.
 *
 * Discovery, not injection, and for the reason `@ReminderRule()` records: a
 * multi-provider token resolves per-injector, so `ApprovalsModule` would have to import
 * every module that governs an approvable item — inverting the dependency graph and
 * making the spine depend on all seven schemas it exists to stay out of.
 *
 * This is not the "callback into modules" the contract rules out. The spine holds an
 * opaque function a module handed it; it learns nothing about the module, and research.md
 * §1 names exactly this — "via that module's service, not a join" — as the mechanism.
 */
export const ApprovalReconcilerProvider = () =>
  applyDecorators(
    Injectable(),
    SetMetadata(APPROVAL_RECONCILER_METADATA, true),
  );
