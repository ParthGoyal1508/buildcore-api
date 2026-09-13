# Research: Approval Spine (Backend)

**Feature**: 016-approval-spine-backend | **Date**: 2026-09-13

Seven decisions. The first is the one everything else follows from.

---

## 1. How a cross-module spine lives under Principle I

**Decision**: The spine owns tables in the `shared` schema and references the items it governs
**opaquely**, by `(entityType, entityId)`, with no foreign key into any module's schema. Modules
interact with it only through an exported `ApprovalService`. The spine never queries another
schema; it never needs to.

**Why this is the only shape that works.** Principle I is NON-NEGOTIABLE: a module's Prisma queries
may only touch its own schema, and anything one module needs from another goes through an exported
service method. An approval chain spans `hr` (attendance), `payroll` (runs), `inventory` (indents),
`labour` (muster rolls, payment sheets), `projects` (RA bills), `plant` (hire bills) and
`recruitment`. A single approval table with a real relation to any of those would be a cross-schema
join by construction — and seven of them would be seven violations.

An opaque reference is not a workaround for the principle; it is the principle applied. The spine
is a module like any other, its schema is its boundary, and it happens to store identifiers it
cannot dereference. Modules ask the spine; the spine asks nobody.

**The cost, stated plainly.** No foreign key means no referential integrity. A deleted indent leaves
an approval record pointing at nothing. Three mitigations, in order of value:

1. Items under an incomplete chain **must not be hard-deleted** — modules already soft-delete
   (`MaterialIndent.deletedAt`, `Payment.deleted`), so this is mostly already true.
2. The spine exposes `abandon(entityType, entityId, reason)`, which modules call when an item is
   cancelled, so the chain closes rather than dangling.
3. A reconciliation sweep reports approvals whose owning module reports the item missing — via that
   module's service, not a join.

**Alternatives rejected**:
- *Approval columns per module table*, as `MaterialIndent` does today (`approvedByUserId`,
  `approvedAt`). It is what exists and it is exactly what this feature replaces: it cannot express
  a sequence, and every module reinvents the rules. Six modules, six subtly different behaviours, is
  the outcome 016 exists to prevent.
- *A polymorphic Prisma relation.* Prisma has no such thing. Emulating one with a union table per
  entity type would put a spine table in every module's schema — Principle I again, and the
  duplication back.

---

## 2. Role slots, and how authority resolves

**Decision**: `ApprovalChain` has ordered `ApprovalLevel` rows; each level names a **slot key**
(a string like `first_approver`, `hr`, `final`). A separate `RoleSlotMapping` per company binds a
slot key to a `Role` id. Authority is resolved at decision time by looking up the mapping, then
checking the caller's roles.

**Why not store a role id on the level.** The client runs two companies that may staff the same
chain shape differently, and neither "HR Office" nor "Site Incharge" exists as a role today. A level
that names a role hardcodes one org chart into the chain definition; a level that names a slot
describes the *shape* of authority and lets settings supply the people.

**Resolution happens at decision time, not at chain creation.** An item already in flight therefore
follows the current mapping if the mapping changes mid-chain. This is deliberate: the alternative —
snapshotting the mapping onto the item — means a role reorganisation leaves items pointing at
people who no longer hold the role, which is worse. The audit record captures who actually decided,
so history stays truthful either way.

**Unmapped slot is a configuration fault, not a 403** (spec FR-001b). Returning "forbidden" would
send an administrator hunting through permissions for a problem that lives in settings. A distinct
error code, and the boot-time-style visibility of feature 015's cookie preflight, is the pattern
being reused here: a misconfiguration that has no error is a misconfiguration nobody fixes.

---

## 3. Enforcing "one person, one decision per item"

**Decision**: A partial unique index on `ApprovalDecision (approvalInstanceId, actorUserId)` where
the decision is a chain-advancing one. Attempted violations surface as a distinct refusal, not a
constraint error leaking to the client.

**Why the database and not the service.** Two requests from the same person at two levels can race,
and a service-layer check reads-then-writes. The existing codebase already reaches for this
technique — the reminder ledger's "at most one open per entity/rule/severity" is a hand-authored
partial unique index — so it is an established pattern here rather than a novelty.

**The unsatisfiable-chain problem** (spec FR-021b). If a company maps two slots to the same role and
one person holds it, every item stalls at the second of those levels. This is checked when the
mapping is saved, not when work stops. The check is: for each chain, no two levels may resolve to
the same role under the proposed mapping. It is refused with the conflicting levels named.

This check is cheap and the failure it prevents is expensive and silent, which is the whole reason
it is at definition time.

---

## 4. Scheduled payroll creation

**Decision**: A `PayrollScheduleCron` in the payroll module, following `ReminderEvaluationCron`
exactly — a thin `@Cron` class calling a service method, errors logged rather than rethrown, the
service independently callable so tests never wait for a scheduler.

**Idempotency** comes from a unique constraint on `PayrollRun (companyId, period, isFnf)` rather
than from the scheduler being careful. A cron that fires twice, an instance that restarts mid-run,
a manual trigger racing the schedule — all end at the same constraint. Scheduler-level care would
have to be correct in every one of those paths; a constraint is correct in all of them at once.

**Timezone**: `0 30 0 1 * *` in Asia/Kolkata via `@nestjs/schedule`'s `timeZone` option, matching the
business timezone already used by attendance. "The 1st" means the 1st in Kolkata, not in UTC.

**Cold-start risk, recorded**: the production API suspends when idle. A cron on a suspended instance
does not fire. This is an infrastructure fact, not a code defect, and it means the scheduled run
cannot be relied upon until the deployment changes. A manual "create run for period" path must
therefore exist regardless (and does, today).

---

## 5. Locking attendance during payroll review

**Decision**: The attendance write path asks payroll, through an exported service method, whether the
date falls in a period under review. Payroll owns the answer; `hr` never reads `payroll` tables.

**Why a synchronous call rather than an event.** Principle I permits both, and directs events at
fan-out that needs no answer. This needs an answer before a write proceeds, so it is a direct call.

**Invalidating approvals on edit** (spec FR-017) is the reverse direction: attendance changed, so the
run's approvals are void. That *is* fan-out — payroll does not need to answer, only to react — so it
goes on the event bus, which Principle I names for exactly this.

---

## 6. Where audit lives

**Decision**: `ApprovalDecision` is the record of who decided what, and it is the spine's own table.
`AuditLogEntry` additionally receives an entry for refused attempts and for chain configuration
changes.

**Why not put decisions in `AuditLogEntry`.** It is an append-only log keyed by 91 entity types,
built for forensics. Decisions are operational state read on every render of an item — "who is this
waiting on" is a query the interface makes constantly. Serving that from the audit log would make
the log load-bearing for the hot path, and would mean the item's current state was derived by
replaying a log rather than read.

Refused attempts do belong in the audit log: they are security-adjacent, rare, and nothing reads
them on a hot path. `AuditEntityType` gains values for approval decisions and refusals.

---

## 7. What migrating a module onto the spine means

**Decision**: Attendance exceptions first (client-settled). A module is migrated when its bespoke
approval columns are replaced by an `ApprovalInstance`, not when both exist.

**Existing single-step approvals keep working until their module is migrated** (spec FR-022). This is
not a nicety: migrating seven modules in one change would be a release nobody can review or roll
back. `MaterialIndent.approvedByUserId` and its siblings stay exactly as they are until each
module's turn.

**Data migration for attendance exceptions**: the existing `resolve` endpoint records a single
resolution. Historical resolutions are backfilled as completed single-level instances, so history
renders through the same path as new work rather than needing a second code path in the interface
forever.
