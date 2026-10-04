# Data Model: Daily Work Reports (022)

Phase 1 of [plan.md](./plan.md). Decisions behind each change are in
[research.md](./research.md).

Both tables already exist, created by 008 in August 2026 and never written to. This feature changes
six columns and adds no table. Measured against the development database on 2026-10-04:
`projects."DailyWorkReport"` 0 rows, `projects."DWRTask"` 0 rows — so every change below is
additive with no backfill (research §1).

---

## Changed: `DWRTask` — `projects`

| Field | Change | Type | Notes |
|---|---|---|---|
| `servedQty` | **new** | `Decimal? @db.Decimal(18, 3)` | The quantity of a presence-paid day: 1 for a full day, less for a part day. Non-null exactly when `paymentMode = day_basis`. |
| `actualQty` | **loosened** | `Decimal? @db.Decimal(18, 3)` | Was `NOT NULL`. A presence-paid line has no *measured* quantity, and absence is the honest representation — zero is a legitimate measured quantity (research §3). Non-null exactly when `paymentMode = work_basis`. |
| `equipmentId` | **new** | `String?` | A bare `plant.Equipment` id, no cross-schema relation — the same pattern as `supervisorEmployeeId` and `approvedByUserId`. Without it FR-032 has no key to read a logbook entry by (research §5). |

Unchanged and reused as they stand: `dwrId`, `boqItemId` (nullable — freeform work the BOQ itemises
differently), `layer`, `chainageFrom`, `chainageTo`, `roadSide`, `paymentMode`, the six factors
(`nos1`, `nos2`, `length`, `breadth`, `depth`, `density`, each `Decimal @default(1)`),
`exceedsScope`, `engineerName`, `remark`, `layerNo`, `section`.

### The constraint the Prisma schema cannot express

```sql
ALTER TABLE "projects"."DWRTask"
  ADD CONSTRAINT "DWRTask_quantity_matches_basis" CHECK (
    ("paymentMode" = 'work_basis' AND "actualQty" IS NOT NULL AND "servedQty" IS NULL)
    OR
    ("paymentMode" = 'day_basis'  AND "servedQty" IS NOT NULL AND "actualQty" IS NULL)
  );
```

Appended to the generated migration, which is the one deviation tracked in plan.md's Complexity
Tracking. It is here rather than in the service because the thing it protects is the quantity that
moves a billed counter, and a service-level invariant is one `prisma.dWRTask.create` away from
being bypassed. The whole point of decision D1 was to stop a quantity being right by coincidence.

### The quantity in force

Not a column. A function, `quantityInForce(line)` in `src/projects/dwr/dwr-quantity.ts`:

| `paymentMode` | Quantity in force | The six factors |
|---|---|---|
| `work_basis` | `actualQty`, computed server-side as `nos1 × nos2 × length × breadth × depth × density` | read; an unsupplied factor is 1, a factor of 0 is refused by name (FR-004) |
| `day_basis` | `servedQty`, supplied by the caller | **not read, and not accepted on input at all** (FR-030b) |

The `day_basis` input type does not carry factor fields, so the second column of that table is a
property of the types rather than a convention. The reason is in research §3: all six factors
default to 1, so their product is 1 — indistinguishable from one day served, right by coincidence,
and wrong the moment somebody sets a factor.

---

## Changed: `DailyWorkReport` — `projects`

| Field | Change | Type | Notes |
|---|---|---|---|
| `reversedAt` | **new** | `DateTime?` | When the latest reversal happened. A report in `draft` with this set was approved and taken back — distinguishable from one never approved, which FR-019 needs. |
| `reversedByUserId` | **new** | `String?` | `shared.User.id`, bare. |
| `reversalReason` | **new** | `String?` | Required by the service, not by the column: a reversal moves a quantity a bill may depend on. |
| `reversalCount` | **new** | `Int @default(0)` | "Has this been round before", answerable without a query. The precedent is `RABill.revisionCount` and its docblock (research §7). |

`approvedAt` and `approvedByUserId` are **not cleared** on reversal. The approval happened; erasing
it leaves a reversal reason referring to an approval nobody can see.

Unchanged: `projectId`, `workDate`, `dprNumber`, `supervisorEmployeeId`, `weather`, `status`,
`workerCount`, `machineryCount`, `progress`, `location`, `description`, `contractFor`,
`contractNumber`, `rfiNo`, `layer`, `fileRefs`, and the existing
`@@unique([companyId, dprNumber])`.

### State transitions

```
                   submit                approve
    ┌─────────┐ ───────────> ┌───────────┐ ─────────> ┌──────────┐
    │  draft  │              │ submitted │            │ approved │
    └─────────┘ <─────────── └───────────┘ <───────── └──────────┘
         ▲       returnToDraft                reverse
         │                                   (+reason)
         └── delete (draft only)
```

| Transition | Moves `doneQty`? | Refused when |
|---|---|---|
| create → `draft` | no | locked project; future work date; BOQ line in another project; a factor of 0; a short served day with no remark |
| `draft` → `submitted` | **no** (FR-011) | no measurement lines (FR-024) |
| `submitted` → `approved` | **yes**, `+ quantityInForce` per line (FR-012) | not submitted (FR-016); approver is the author (FR-012a); already approved (FR-014) |
| `submitted` → `draft` | no | — |
| `approved` → `draft` (reverse) | **yes**, `− quantityInForce` per line (FR-019) | reversal would drop a BOQ line's `doneQty` below the quantity already billed against it on a non-draft bill (FR-020, research §4); would drive a counter negative (FR-021) |
| delete | no | status is not `draft` (FR-023) |

Editing an `approved` report is refused outright, naming the reversal path (FR-018).

---

## Unchanged, but written by this feature: `BOQTaskItem.doneQty` — `projects`

`Decimal @default(0) @db.Decimal(18, 3)`. The counter this feature's approvals and reversals move,
through `BoqService.updateDoneQty` — which has existed since August, is exported from
`ProjectsModule` for this caller, and has had no caller.

Always moved by a **relative** increment (`{ increment: … }`), never by a value read earlier in the
same operation (FR-015), so two reports measuring one line and approved concurrently both land.
Never below zero (FR-021).

---

## Read, never written: `plant.LogbookEntry`

Already holds exactly what the client's measurement sheets print beneath each item: `date`,
`openingReading`, `closingReading`, `totalHours`, `fuelConsumed`, `operatorId`, `projectId`,
`remarks`, unique per `(equipmentId, date)`.

Reached through a new `ProjectLogbookSource` on `ProjectSourcesRegistry`, registered by
`PlantService.onModuleInit`, returning a **map keyed by date** so a date with no entry is absent
rather than zero (FR-033). Never queried from `projects` and never copied into it — a second system
of record for an odometer reading would disagree the first time one was corrected (research §5).

---

## Not stored, and deliberately

- **Approved measurement per BOQ line per period** (FR-034 to FR-038) — aggregated at read time
  over approved reports, attributed by work date. 018 research §3 decided this pattern for
  cumulative billed quantity and named `doneQty` as the existing counter; adding a second counter
  for the same quantity would be doing knowingly what 018 declined to do (research §6).
- **Reversal history** — the latest reversal is on the report; the sequence is in the audit log,
  which is the system of record for who did what (research §7).
- **Which bill line consumed which report's measurement** — no such link exists anywhere in the
  schema today, and 022 does not invent one. This is why FR-020 **is** a billed-quantity floor
  rather than a provenance check — it was rewritten to say so after
  `checklists/silent-failure.md` CHK029 found that its original wording described a condition no
  implementation could determine. FR-020a now makes deciding the linkage an obligation on 023,
  so the question is asked rather than inherited as a gap that looks closed.

---

## Row-level security

No new table, so no new policy: `projects."DailyWorkReport"` and `projects."DWRTask"` have carried
`tenant_isolation` since 008's migration.

What they have never had is a test proving it. The development and continuous-integration database
role is a superuser, and **Postgres exempts superusers from row-level security unconditionally** —
so neither policy has been in force in any test run since the day it was written. This session
established that 148 tables carry the policy while about 21 are named in the five existing probe
suites, and that this gap is what let a `42501` reach production.

`test/dwr-rls.e2e-spec.ts` is therefore a deliverable of this feature (FR-040), following
`test/company-selection-rls.e2e-spec.ts`: a `NOSUPERUSER NOBYPASSRLS` probe role, and its
non-vacuity test asserting the probe role was actually created — without which the suite passes
against a superuser connection and proves nothing at all.
