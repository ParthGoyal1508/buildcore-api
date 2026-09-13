# Quickstart: Approval Spine (Backend)

**Feature**: 016-approval-spine-backend

Runnable validation. Every pass below is either a jest run or a real HTTP exchange — none is "read
the code and satisfy yourself".

## Prerequisites

```bash
cd /Users/parthgoyal/Projects/buildcore-api
npm install
npx prisma migrate dev          # applies the spine migration
npm run seed                    # local only; refuses a non-localhost DATABASE_URL
npm run start:dev               # watch mode, so .env changes land
```

Sign in as `admin@buildcore.dev` / `secret42` to obtain a token for the HTTP passes.

## Pass 1 — The chain refuses what it should

The core of the feature. Everything else is elaboration.

```bash
# Submit an attendance exception into its chain, then attempt to approve it
# as somebody whose role is not mapped to level 1.
curl -s -X POST localhost:3000/approvals/$INSTANCE/decide \
  -H "Authorization: Bearer $WRONG_ROLE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"action":"approve"}'
```

Expect `403` with `code: "APPROVAL_NOT_AUTHORISED"`, and an `AuditLogEntry` of type
`APPROVAL_REFUSED` recording the attempt.

## Pass 2 — One person cannot decide twice (FR-021a)

The pass that proves the chain is control rather than ceremony.

1. As a Super Admin (who holds every permission), approve at level 1.
2. Attempt to approve the same item at level 2.

Expect `403` with `code: "APPROVAL_ALREADY_DECIDED"` — **not** `APPROVAL_NOT_AUTHORISED`. The
distinction is the point: this person *does* have the authority and is still refused.

Then confirm the partial unique index holds under a race:

```bash
# Both at level 2, same actor, fired together
for i in 1 2; do curl -s -X POST .../decide -H "..." -d '{"action":"approve"}' & done; wait
```

Exactly one succeeds.

## Pass 3 — An unsatisfiable chain is refused at definition time (FR-021b)

```bash
# Map two slots of the same active chain to one role
curl -s -X PUT localhost:3000/approvals/slot-mappings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"mappings":[{"slotKey":"hr","roleId":"'$R'"},{"slotKey":"final","roleId":"'$R'"}]}'
```

Expect `400` naming both conflicting levels. Accepting this mapping would stall every item in that
chain at level 2, silently and permanently — which is why it is caught here rather than when payroll
stops.

## Pass 4 — An unmapped slot is a configuration fault, not a 403 (FR-001b)

Remove a slot mapping, then attempt a decision at that level. Expect `APPROVAL_SLOT_UNMAPPED`, and
a message that names the slot and points at settings. A bare `403` would send an administrator
hunting through permissions for a problem that lives in a different screen entirely.

## Pass 5 — Payroll runs itself, once

```bash
# Trigger the service directly rather than waiting for the schedule
npx ts-node -e "…payrollSchedule.createRunsForPreviousPeriod()"
```

- A run exists for the previous period, `createdBySchedule: true`.
- Run it again: **no second run**, no error — the unique constraint on
  `(companyId, period, isFnf)` absorbs it (research.md §4).
- The run is `pending` in the spine, not payable.

## Pass 6 — The bank sheet is held until the chain completes (FR-015)

Request a bank transfer sheet for a run awaiting approval. Expect a refusal naming the outstanding
level. Approve through every level, request again, expect the file.

## Pass 7 — Only HR may edit attendance under review (FR-016)

1. As a non-HR user, edit attendance for a date inside a period under payroll review → refused.
2. As the HR-mapped role, the same edit → permitted.
3. Confirm the run's prior approvals are invalidated and its chain restarted (FR-017), and that the
   invalidation arrived over the event bus rather than a direct call from `hr` into `payroll`
   (research.md §5).

## Pass 8 — The queue shows only actionable work

As a user who has already decided on an item at level 1, confirm it does **not** appear in
`GET /approvals/queue` when it reaches a level they also hold. A queue that lists work the user is
forbidden to action is worse than an empty one.

## Pass 9 — Batch state, not N+1

Render a list of 50 items with approval state. Confirm **one** call to `statesOf`, not 50 to
`stateOf`. Add a test asserting the query count; this is the mistake the contract exists to prevent
and it will otherwise be made by the third module to migrate.

## Pass 10 — Principle I is not violated

```bash
# No spine table may be referenced from a module's own queries, and vice versa.
grep -rn "approvalInstance\|approvalDecision\|approvalChain" src/ --include='*.ts' \
  | grep -v "src/approvals/" | grep -v spec
```

Expect only imports of `ApprovalService` — no Prisma access to spine tables from outside
`src/approvals/`. This is a grep, not a guarantee, and it is worth running because the violation it
catches is invisible at runtime and only hurts at extraction time.

## Verification gates

```bash
npx tsc --noEmit
npx eslint <touched files>        # NOT `npm run lint` — that is eslint --fix repo-wide
npm test                          # 707 passing before this feature
npm run build
```

## Known limitation to confirm, not discover

The production API suspends when idle, and **a cron on a suspended instance does not fire**
(research.md §4). Pass 5 tests the service, not the schedule. Before relying on automatic payroll
creation in production, either the instance class changes or an external trigger invokes the
endpoint — this is an infrastructure decision and should not be assumed solved by this feature.
