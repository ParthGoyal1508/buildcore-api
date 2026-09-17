# Data Model: Approval Spine (Backend)

**Feature**: 016-approval-spine-backend | **Date**: 2026-09-13

All new tables live in the **`shared`** schema. None has a foreign key into a business module's
schema — see research.md §1 for why that is Principle I applied rather than avoided.

---

## ApprovalChain

The ordered shape of authority for one kind of action, per company.

| Field | Type | Notes |
|---|---|---|
| `id` | String | cuid |
| `companyId` | String | FK → `shared.Company`. Chains are per company. |
| `actionType` | String | e.g. `attendance_exception`, `payroll_run`. The key modules use to find their chain. |
| `isFinalAuthorityRequired` | Boolean | Whether the last level is Super Admin regardless of slot (FR-018). |
| `isActive` | Boolean | Inactive chains stop accepting new items; in-flight items continue. |

**Unique**: `(companyId, actionType)` where active — one live chain per action type per company.

---

## ApprovalLevel

One step. Ordered within its chain.

| Field | Type | Notes |
|---|---|---|
| `id` | String | cuid |
| `chainId` | String | FK → `ApprovalChain`, cascade delete. |
| `position` | Int | 1-based, contiguous. |
| `slotKey` | String | `first_approver`, `hr`, `final` — resolved per company via `RoleSlotMapping`. |
| `isFinalAuthority` | Boolean | This level is the Director gate. |

**Unique**: `(chainId, position)`, and `(chainId, slotKey)` — a slot may not appear twice in one
chain, which is the first half of the unsatisfiable-chain guard (FR-021b).

---

## RoleSlotMapping

Binds a slot to an actual role, per company. This is the table that lets two companies staff the
same chain shape differently.

| Field | Type | Notes |
|---|---|---|
| `id` | String | cuid |
| `companyId` | String | FK → `shared.Company`. |
| `slotKey` | String | Matches `ApprovalLevel.slotKey`. |
| `roleId` | String | FK → `settings.Role`. |

**Unique**: `(companyId, slotKey)`.

**Validation on write** (FR-021b, research.md §3): the proposed mapping must not cause two levels of
any active chain to resolve to the same role. Refused with the conflicting levels named — a chain
where two levels need the same role is unsatisfiable under FR-021a whenever one person holds it, and
the failure is silent and total.

---

## ApprovalInstance

One item travelling a chain. The opaque reference lives here.

| Field | Type | Notes |
|---|---|---|
| `id` | String | cuid |
| `companyId` | String | FK → `shared.Company`. RLS scope. |
| `chainId` | String | FK → `ApprovalChain`. The chain as entered. |
| `entityType` | String | e.g. `attendance_exception`. **No FK** — research.md §1. |
| `entityId` | String | The item's id in its own module's schema. **No FK.** |
| `currentPosition` | Int | Which level it awaits. |
| `state` | Enum | `pending`, `approved`, `rejected`, `returned`, `abandoned`. |
| `originatorUserId` | String | Who raised it. |
| `returnCount` | Int | Times returned and resubmitted (FR-020). |
| `createdAt` / `updatedAt` | DateTime | |

**Unique**: `(entityType, entityId)` where state is not terminal — one live chain per item, which is
what stops a double-submit creating two parallel approvals of the same thing.

**Index**: `(companyId, state, currentPosition)` — serves the approval queue, the hottest read.

---

## ApprovalDecision

One recorded act. Immutable.

| Field | Type | Notes |
|---|---|---|
| `id` | String | cuid |
| `approvalInstanceId` | String | FK → `ApprovalInstance`, cascade. |
| `position` | Int | The level decided at. |
| `actorUserId` | String | FK → `shared.User`. |
| `action` | Enum | `approve`, `reject`, `return`. |
| `reason` | String? | Required for `reject` and `return` (FR-006). |
| `decidedAt` | DateTime | |

**Partial unique**: `(approvalInstanceId, actorUserId)` — enforces FR-021a in the database, where a
race cannot slip past it (research.md §3).

**Unique**: `(approvalInstanceId, position)` — one decision per level, which is FR-021's guard
against two same-level approvers both recording.

---

## Changes to existing models

### PayrollRun (`payroll` schema)

| Change | Reason |
|---|---|
| Unique `(companyId, period, isFnf)` | Idempotency for the scheduled run, enforced by constraint rather than by scheduler care (research.md §4). |
| `createdBySchedule Boolean @default(false)` | Distinguishes an automatic run from a manual one, so an operator can tell whether the schedule is actually firing — which matters given the suspended-instance risk. |

`PayrollRunStatus` is **unchanged**. Approval state lives in the spine, not duplicated here; adding
approval columns would be the per-module pattern this feature replaces.

### AuditEntityType (`settings` schema enum)

Add `APPROVAL_DECISION`, `APPROVAL_REFUSED`, `APPROVAL_CHAIN_CONFIG`. Refused attempts and
configuration changes are security-adjacent and off the hot path (research.md §6).

### Attendance exception (`hr` schema)

The existing single-step resolution fields are **retained** through this feature and backfilled as
completed single-level instances (research.md §7), so historical items render through the same path
as new ones.

---

## State transitions

```
                    ┌──────────── return ────────────┐
                    ▼                                │
  (raised) ──▶ pending ──approve at final──▶ approved
                    │                                ▲
                    ├── reject ──▶ rejected          │
                    │                                │
                    ├── approve (not final) ─────────┘
                    │        (currentPosition + 1)
                    └── abandon (owning module) ──▶ abandoned
```

- `approve` at a non-final level advances `currentPosition` and stays `pending`.
- `return` sets `returned`; resubmission creates decisions afresh from position 1 and increments
  `returnCount`. Prior decisions are retained — the history must show that the item went round.
- `abandoned` is set by the owning module via `ApprovalService.abandon()` when the item is
  cancelled, so a cancelled indent does not leave a chain waiting forever (research.md §1).

## RLS

Every new table is company-scoped and receives a policy in the same shape as existing `shared` tables.
`ApprovalInstance` and `ApprovalDecision` are read on the queue path by ordinary users, so their
policies must be correct for non-super-admin callers — this is the one place where getting RLS wrong
would leak one company's pending work into another's queue.
