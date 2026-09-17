# Contract: ApprovalService (in-process) and the HTTP surface

**Feature**: 016-approval-spine-backend | **Date**: 2026-09-13

Two contracts. The **in-process** one is how modules talk to the spine, and is the more important of
the two — it is the seam Principle I requires, and getting it wrong means modules reach into the
spine's schema instead. The **HTTP** one is what the web application consumes.

---

## Part 1 — `ApprovalService`, exported by `ApprovalModule`

Modules import `ApprovalModule` and call these. **No module may query a spine table directly**, and
the spine queries no module's tables (research.md §1).

### `submit(input): Promise<ApprovalInstanceView>`

Puts an item into its chain.

```
input: {
  companyId, actionType, entityType, entityId,
  originatorUserId,
}
```

- Resolves the active chain for `(companyId, actionType)`. **Throws a configuration fault** if none
  exists — distinct from an authorisation failure (FR-001b).
- Refuses if a non-terminal instance already exists for `(entityType, entityId)`.
- Returns the instance with its first pending level resolved to the role that must act.

### `decide(input): Promise<ApprovalInstanceView>`

Records one decision.

```
input: {
  instanceId, actorUserId, action: 'approve' | 'reject' | 'return',
  reason?,   // REQUIRED for reject and return
}
```

Refusals, each distinguishable by code — because they have different remedies and the interface must
say which (web FR-003a):

| Condition | Code |
|---|---|
| Caller's roles do not include the level's mapped role | `APPROVAL_NOT_AUTHORISED` |
| Caller already decided on this item at an earlier level | `APPROVAL_ALREADY_DECIDED` |
| The level's slot is unmapped for this company | `APPROVAL_SLOT_UNMAPPED` |
| Instance is not pending | `APPROVAL_NOT_PENDING` |
| Reason missing on reject or return | `APPROVAL_REASON_REQUIRED` |

Every refusal is written to `AuditLogEntry` as `APPROVAL_REFUSED` (FR-003, research.md §6).

On the final approval, emits `approval.completed` on the event bus with
`{ entityType, entityId, companyId, instanceId }`. **This is how a module learns its item is
approved** — the spine does not call back into modules, because it cannot know them.

### `stateOf(entityType, entityId): Promise<ApprovalInstanceView | null>`

What a module renders beside its item. Cheap, indexed, called on every list render.

### `statesOf(entityType, entityIds[]): Promise<Map<string, ApprovalInstanceView>>`

The batch form. **Modules MUST use this when rendering a list.** Calling `stateOf` per row is the
obvious mistake and produces an N+1 against the spine from every list in the product.

### `abandon(entityType, entityId, reason): Promise<void>`

Called by the owning module when an item is cancelled or deleted. Closes the chain rather than
leaving it pending forever — the mitigation for having no foreign key (research.md §1).

### `queueFor(userId, companyId, paging): Promise<ApprovalQueueEntry[]>`

Everything awaiting this user across every action type. Resolves the user's roles to slots, then
finds pending instances whose current level maps to one of them, **excluding items they have already
decided on** (FR-021a — otherwise the queue shows work the user cannot action).

### `isPeriodUnderReview(companyId, date): Promise<boolean>`

Payroll's exported method, not the spine's — listed here because attendance calls it and the pairing
is easy to lose. `hr` never reads `payroll` tables (research.md §5).

---

## Part 2 — HTTP surface

All under `/approvals`, guarded by `JwtAuthGuard`. Authority is per-item, resolved by the service;
there is no blanket `APPROVALS` permission, because the right to decide comes from the chain's slot
mapping rather than from a permission value.

### `GET /approvals/queue`

Items awaiting the caller. `?limit=&cursor=`.

```json
{
  "items": [{
    "instanceId": "...", "actionType": "attendance_exception",
    "entityType": "attendance_exception", "entityId": "...",
    "subject": "Rajesh Kulkarni — 11 Sep, out of geofence",
    "requestedBy": "Site Engineer name", "requestedAt": "2026-09-11T...",
    "ageHours": 52, "currentPosition": 2, "levelLabel": "HR"
  }],
  "nextCursor": null
}
```

`subject` is supplied by the owning module when it submits, because the spine cannot read an item it
has no relation to. This is the practical cost of §1's opacity, and it is paid here.

### `GET /approvals/queue/count`

`{ "count": 7 }`. Separate from the queue because the navigation badge polls it and must not pull
the whole list (web FR-012).

### `POST /approvals/:instanceId/decide`

```json
{ "action": "approve" | "reject" | "return", "reason": "..." }
```

`201` with the updated instance. `403` with one of the codes above. DTO-validated (Principle II) —
note that a DTO is mandatory here even though the body is small, because the codebase has already
been bitten by `@Query()` params without one.

### `GET /approvals/:entityType/:entityId/history`

The full ordered decision history for one item, subject to the caller's permission to view that item
— which the **owning module** decides, not the spine.

### `GET /approvals/chains` · `POST /approvals/chains` · `PUT /approvals/chains/:id`

Chain definition. Requires `SETTINGS`.

### `PUT /approvals/slot-mappings`

Binds slots to roles for a company. Requires `SETTINGS`. **Refuses a mapping that would make any
active chain unsatisfiable**, naming the conflicting levels (FR-021b, data-model.md).

---

## What this contract deliberately does not do

- **No polymorphic expansion.** The spine never resolves `entityId` into the item. Every caller that
  needs item detail fetches it from its own module.
- **No permission for approving.** Authority is the slot mapping. Adding an `APPROVALS` permission
  would create two sources of truth about who may decide.
- **No callbacks into modules.** Completion is an event. A spine that called modules would need to
  know them, and Principle I exists to stop exactly that.
