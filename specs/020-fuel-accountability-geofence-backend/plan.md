# Implementation Plan: Fuel Accountability and Per-Employee Geofence (backend)

**Branch**: `020-fuel-accountability-geofence-backend` | **Date**: 2026-09-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/020-fuel-accountability-geofence-backend/spec.md`,
clarified 2026-09-16 (the punch-refusal decision and the three thresholds it made blocking).

## Scope of this plan

**This plan covers User Story 3 only — the geofence and punch-refusal half.**

The client is working `bugs.md` in batches of four, and only item 2 (*"Block attendance marking if
location or photo verification fails"*) falls in the first batch. User Stories 1 and 2 — the fuel
variance consequences, hire deductions and operator recoveries — are `bugs.md` item 13 and belong to
a later batch. They are **not planned here**, and the one open `[NEEDS CLARIFICATION]` left in the
spec (the cap on operator salary recovery) is theirs, not this half's.

Said explicitly because a plan that silently covered half its spec would read as an omission. The
spec's own checklist note records the same split.

## Summary

Today a punch is **always recorded**. Face matching and geofencing run, disagree, and set
`faceMatchResult` / `geofenceResult` to `exception` on a row that exists either way —
`punch.service.ts:257` states it in a comment: *"Neither check can reject the punch; both can flag
it."* That comment is the subject of this work.

The client's decision of 2026-09-16 inverts it: a punch that fails location or face validation is
refused, and **no attendance record is created in any state**. Three things follow. The refusal needs
somewhere to live that is not attendance (FR-013c). The punch needs to carry its own reported location
accuracy, which it does not today, so that an honest fix in a bad spot is not refused for being
imprecise (FR-012a). And a genuinely worked day needs a route back, which is feature 016's manual
correction chain and not this feature's problem to solve — only its problem to depend on.

Per-employee location assignment (FR-011) is the smaller, additive part: geofences are per-`Site`
today, and an employee-level assignment layers over that with the site fence as the fallback for
anyone unassigned.

## Technical Context

**Language/Version**: TypeScript 5.x on Node, NestJS 10

**Primary Dependencies**: `@nestjs/*`, Prisma 5.22 (multiSchema), `nestjs-prisma`, `class-validator`.
Face matching and image handling are consumed from feature 003 unchanged — no new dependency.

**Storage**: PostgreSQL, multi-schema. Punch photos already go through `src/common/storage/`; a
refused punch's photo is discussed in D20 below and is the one storage question this feature raises.

**Testing**: Jest — unit specs beside sources, e2e in `test/` against a real database.

**Target Platform**: Linux server (Render), Postgres (Neon)

**Project Type**: Web service (NestJS API), paired with a Next.js frontend planned separately.

**Performance Goals**: NFR-001 — punch validation within 2s at p95 with 150 concurrent users in a
15-minute window. **Unverified**, as the spec says plainly; this plan does not make it verified.

**Constraints**: Constitution Principles I–VI. RLS on every new table, hand-authored. The refusal
path must add no query to the accepted path — an accepted punch must not pay for the refusal
machinery.

**Scale/Scope**: One user story, one new table, one changed service method, one new DTO field, one
company setting. Materially smaller than 016 or 017.

## Constitution Check

| Principle | Assessment |
|---|---|
| **I. Schema-per-module boundaries** (NON-NEGOTIABLE) | `PunchRefusal` and `EmployeeLocationAssignment` both go in `hr`, beside `PunchRecord` and `Employee`. The accuracy threshold is company configuration and belongs in `settings`, read by `hr` through `CompaniesService` — the same route `getPayrollLockDay` already takes in this very method, so no new cross-module reach. |
| **II. Validated DTO contracts** (NON-NEGOTIABLE) | `SubmitPunchDto` gains `accuracyMeters` with a numeric validator and bounds. The refusal response is a typed error body, not a bare string. |
| **III. Centralized configuration** (NON-NEGOTIABLE) | The accuracy maximum is **not** a literal and not only an env var: the client asked for it to be settable by a Super Admin, so it is a stored company setting with the 50-metre default living in config as the fallback. See D19. |
| **IV. Multi-tenant isolation & PII** (NON-NEGOTIABLE) | `PunchRefusal` gets `ENABLE` + `FORCE` RLS and a `tenant_isolation` policy in hand-authored SQL, proved with the `NOSUPERUSER NOBYPASSRLS` probe role. It holds **location and a failed-verification reason about a named person**, which is more sensitive than the punch it replaces — read access is permission-gated, not open to anyone who can see attendance. |
| **V. AuthN/AuthZ & secrets** | The refusal log is readable under an attendance-audit permission. An employee reads their own refusals and nobody else's, by construction of the `my/*` route. |
| **VI. Observability & safe migrations** | Both new tables are additive, so no backfill. **`faceMatchResult`/`geofenceResult` keep their `exception` values** — historical rows carry them legitimately and a migration that removed the enum value would destroy real history. New rows simply never take it. |

**Gate result**: PASS. No violation requires justification in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/020-fuel-accountability-geofence-backend/
├── spec.md
├── plan.md              ← this file (User Story 3 only)
├── research.md          ← Phase 0
├── data-model.md        ← Phase 1
├── contracts/
│   └── punch-validation.md
├── quickstart.md        ← Phase 1
└── checklists/requirements.md   (15/16)
```

### Source Code (repository root)

```text
src/hr/
├── punch/
│   ├── punch.service.ts            # CHANGED — the inversion. Refuse instead of flag
│   ├── punch.controller.ts         # CHANGED — refusal response; own-refusal read
│   ├── geofence.util.ts            # CHANGED — accuracy allowance (FR-012a)
│   ├── punch-refusals.service.ts   # NEW — write the log, read it back
│   └── dto/                        # CHANGED — accuracyMeters
├── employees/
│   └── location-assignment/        # NEW — FR-011, assignment + history
└── attendance/                     # UNCHANGED by this feature (016 owns corrections)

src/settings/
└── companies/                      # CHANGED — the accuracy maximum as a company setting

prisma/
├── schema.prisma                   # CHANGED — 2 new models, 1 new column on Company
└── migrations/                     # NEW — additive, plus RLS policies
```

**Structure Decision.** Everything lands inside `src/hr/punch/` rather than in a new top-level
module. This is one method's behaviour changing plus a log beside it; a module boundary would buy
nothing and would separate the refusal from the code that produces it.

## Approach

### Phase order

1. **Accuracy first, still non-blocking.** Add `accuracyMeters` to the DTO, the allowance to
   `checkGeofence`, and the company setting. Punches still record exceptions as today. Nothing
   user-visible changes except that a punch near a fence edge with a poor fix now reads as in-range.
   Independently releasable and independently valuable.
2. **The refusal log, written but not yet blocking.** Create `PunchRefusal` and write a row whenever
   a punch *would* be refused, while still recording the punch as an exception. This produces real
   data about how many punches the hard block will refuse, **before** the block is switched on — which
   is the only honest way to size the correction traffic the client accepted.
3. **The inversion.** Refuse the punch, stop writing the exception row. Gated behind 016's correction
   chain existing (see Risks).
4. **Per-employee assignment** (FR-011, FR-014, FR-016). Independent of 1–3 and can ship at any point.

Phase 2 is the phase worth insisting on. The client chose a hard block over a reviewable exception,
and phase 2 measures the cost of that choice while it is still reversible.

### What deliberately does not change

- **Face matching itself.** Threshold, library, enrolment, comparison — all consumed from feature 003
  unchanged, per the spec's clarification. This feature changes the consequence of a mismatch and
  nothing about how a mismatch is determined.
- **The site geofence.** It remains, it continues to serve supervisor-marked labour attendance, and it
  is the fallback for an employee with no individual assignment (FR-016).
- **Fuel variance detection.** Out of scope for this batch entirely (see Scope, above), and FR-017
  says it stays unchanged regardless.

## Key decisions

### D17 — the inversion happens where the comment is, and the comment goes with it

`punch.service.ts` computes `isException` from `faceMatchResult` and `geofenceResult` and then writes
the row regardless. The change replaces that with a refusal thrown **before** the write — before the
photo is stored, before the `FOR UPDATE` day lock, before the insert.

Ordering it before the storage write matters: a refused punch that has already put a blob in object
storage leaves an orphan whose only referent was the row that was never created. See D20.

The comment at `punch.service.ts:257` — *"Neither check can reject the punch; both can flag it"* — is
rewritten in the same commit. A comment stating the opposite of the code is worse than no comment, and
this one is load-bearing: it is the first thing a reader of this method learns.

**The reader audit is part of this decision, not a follow-up.** FR-013a now enumerates seven readers
and FR-013d makes the guarantee structural. The audit is therefore a task in its own right: walk each
of the seven and confirm it reads a refused day as a day with no punch. Three of the seven — absence
counting, leave-balance accrual and shift-compliance reporting — were not named until the requirements
review asked which readers FR-013a actually bound, and each had a different plausible answer for a
refused day. The structural guarantee is what makes the audit finite rather than perpetual: nothing is
stored in the attendance table, so a reader that never heard of refusals is correct by construction.

### D18 — the refusal is a 422, and it names which check failed

Not a 400: the request is well-formed. Not a 403: the caller is entitled to punch. Not a 409: the
day's state is irrelevant. `422 Unprocessable Entity` with a typed body carrying a stable code —
`PUNCH_REFUSED_LOCATION`, `PUNCH_REFUSED_FACE`, `PUNCH_REFUSED_UNLOCATABLE` — and human text. FR-013b
requires the employee to learn which check refused them, and a client cannot branch on prose.

`PUNCH_REFUSED_UNLOCATABLE` is deliberately distinct from `PUNCH_REFUSED_LOCATION`: "you are not where
you should be" and "your phone cannot tell where you are" call for different actions from the person
holding it, and collapsing them would tell a worker standing in the right place to move.

### D19 — the accuracy maximum is a stored company setting, because the client asked for that

The obvious implementation is an env var, and this feature already has a precedent for one —
`WORKSPACE_LABOUR_GPS_ACCURACY_MAX_METRES`, feature 013's labour muster threshold, default 50. **It is
not enough.** The client's answer was "configurable from the settings by super admin", and an env var
is changeable only by whoever deploys.

So: a nullable `punchAccuracyMaxMetres` column on `settings.Company`, read through `CompaniesService`
alongside `getPayrollLockDay` in the same method, falling back to the existing config default when
null. Three properties this buys: a company that configures nothing behaves exactly as the 50-metre
default describes, the default itself stays in configuration rather than in a service (Principle III),
and 013's labour threshold is left completely alone — it is a different surface with a different
tolerance and merging them would couple two unrelated decisions.

Write access under `COMPANY_SETTINGS`, which Super Admin holds by definition.

### D20 — a refused punch's photo is not kept

`PunchRefusal` records who, when, where, the reported accuracy and which check failed. It does **not**
store the photo.

The tempting argument for keeping it is that a face-mismatch refusal is the one case where an image
would settle a dispute. It is rejected: the photo is biometric data about a person, the refusal means
the system could not establish whose face it is, and retaining unattributed biometrics indefinitely
against a named employee is a materially worse privacy position than the attendance record it replaces
— which at least the employee knew they were creating. Principle IV's PII posture points the same way.

The consequence is stated rather than hidden: a face-mismatch refusal cannot be audited by looking at
the photo. The recovery route is 016's correction, which rests on the supervisor's assertion — exactly
as the spec's clarification says it does.

### D21 — the accuracy allowance is additive, and an absent accuracy means no allowance

`checkGeofence(punch, site)` returns `withinGeofence: distance <= radius`. It gains an optional
accuracy: `distance <= radius + (accuracyMeters ?? 0)`.

`?? 0` is the whole backward-compatibility story. A client that does not send `accuracyMeters` — every
client shipped today — gets exactly today's verdict, so phase 1 cannot regress anyone. And the
inclusive boundary stays inclusive, for the reason already written into that function: making the
verdict at the boundary depend on floating-point rounding is not a defensible way to decide whether
someone gets paid.

The refusal for exceeding the maximum is checked **before** the allowance is applied, not after.
Otherwise a 500-metre accuracy would first be refused as unlocatable and then, on a wider fence, be
allowed in by its own imprecision — the allowance rewarding the very thing the maximum rejects.

### D22 — per-employee assignment is a history table, not a column

FR-011 requires every change to an employee's location assignment recorded with author and effective
date. A column on `Employee` cannot carry that, and FR-013's own acceptance scenario 4 requires
punches to validate against the *new* location from the effective date — which is a question about a
timeline, not a current value.

So `EmployeeLocationAssignment` rows with `effectiveFrom`, and resolution is "the row with the latest
`effectiveFrom` at or before the punch's day". No assignment at all falls back to the site fence
(FR-016). `isMobile` (FR-014) is a column on the assignment rather than on `Employee`, so exempting
someone is itself an attributable, dated act rather than a flag someone flipped.

## Complexity Tracking

No constitutional violation requires justification. Two items are recorded as cost:

| Item | Why it is accepted |
|---|---|
| A second store for something attendance-shaped (`PunchRefusal`) | FR-013a requires a refused day to read as *no punch* to every later reader. The only way to guarantee that against readers that already exist is for the refusal not to be in the attendance table at all. A status column on `PunchRecord` would require every existing query to learn to exclude it, and the one that forgot would pay someone for a refused day. |
| An accuracy value the client must send and may not | The threshold is meaningless without it, and no existing client sends it. `?? 0` makes the absence safe rather than silently permissive, at the cost of the web and mobile clients needing a change before the allowance does anything for anyone. |

## Risks

| Risk | Handling |
|---|---|
| **The hard block ships before 016's correction chain, leaving refused days with no route back.** | Phase 3 is gated on 016's manual correction chain existing. This is an ordering constraint the spec's Assumptions state explicitly, and it is the single most consequential item in this plan. |
| Refusal volume is unknown until the block is live, and the client accepted the cost blind. | Phase 2 exists precisely for this: log the would-be refusals while still accepting the punches, and report the rate before phase 3 switches the block on. |
| A company sets the accuracy maximum so high the allowance swallows the fence. | Named in the spec's edge cases. Not capped — it is a company decision — but the setting's description says what it does, and the quickstart asserts the interaction rather than leaving it to be discovered. |
| No client sends `accuracyMeters`, so the allowance is inert and every poor fix is refused on its raw point. | Phases 1 and 2 ship before the block, so the inertness is visible in the phase-2 refusal rate rather than in refused workers. The web/mobile change is a dependency of phase 3, not of phase 1. |
| `PunchRefusal` becomes an approval queue by accretion — someone adds a "resolve" action and it turns back into the exception the client rejected. | FR-013c says it plainly: a log, not a reviewable item, and nothing in it can be approved into a present day. The e2e asserts there is no route that promotes a refusal to attendance. |

## Verification

`npx tsc --noEmit`, `npx eslint <touched files>` (**not** `npm run lint` — that is `eslint --fix`
repo-wide), `npx jest <touched specs>`, and the e2e suite against a real database. RLS on
`PunchRefusal` is proved with the `NOSUPERUSER NOBYPASSRLS` probe role rather than asserted, following
016 and 017.

## Phase status

- **Phase 0 — research**: [research.md](./research.md)
- **Phase 1 — design**: [data-model.md](./data-model.md),
  [contracts/punch-validation.md](./contracts/punch-validation.md), [quickstart.md](./quickstart.md)
- **Post-design constitution re-check**: PASS — two additive tables, both RLS-covered, no new
  cross-schema query, and the one PII decision (D20) resolved toward retaining less rather than more.

**Next**: `/speckit-tasks` for User Story 3. User Stories 1 and 2 are planned when `bugs.md` item 13
reaches its batch.

## Amendment — 2026-09-29: User Stories 1 and 2, the fuel half (bugs.md item 13)

### Scope

This plan previously covered User Story 3 only — the geofence half — and said US1 and US2 would be
planned "when bugs.md item 13 reaches its batch". It has. FR-001 to FR-010 are planned here.

### What already exists, and what the client is actually asking for

Detection is **built**, and it is the harder half:

| Piece | Where |
|---|---|
| The benchmark per machine | `Equipment.fuelBenchmark Decimal?` (schema line 4101) |
| Actual versus benchmark | `FuelEntry.variancePercent Decimal?` (4404) |
| The alert | `FuelEntry.varianceAlert Boolean @default(false)` (4405) |
| The hire bill to deduct from | `HireBill` with `grossAmount`, `tdsAmount`, `netPayable`, `status` (4486) |
| A salary-deduction precedent | `SalaryAdvance` (2443) recovering against `PayrollLineItem` (2525) |

So nothing here detects anything new. FR-017 says so explicitly, and this amendment adds no change to
the detection path. What is missing is **consequence**: an alert that nobody has to act on, and no way
to turn a confirmed one into money recovered from either the hirer or the operator.

### D26 — the exception is a record, not a query over alerts

`FuelEntry.varianceAlert` is a boolean on a reading. An exception under FR-001 needs a state that
outlives the reading — reviewed, attributed, dismissed, recovered, reversed — and a boolean cannot
carry it.

`plant.FuelVarianceException`, one row per confirmed-or-dismissed alert, referencing the `FuelEntry`
that raised it. The boolean stays as the detector's output; the exception is the review's subject.

Why not a status enum on `FuelEntry`: a reading is a fact about a machine at a time, and it should not
acquire a workflow. Correcting a reading and dismissing an exception are different acts by different
people, and putting both on one row makes the second look like an edit of the first.

### D27 — attribution is a required choice with no default

FR-002 attributes a confirmed exception to the hirer, to the operator, or to neither. There is
deliberately **no default**: a default would decide, quietly and at scale, who pays for fuel nobody can
account for. The reviewer names it, or the exception stays open.

FR-009 already requires the operator be named explicitly where a machine had more than one. This
extends the same principle to the attribution itself.

### D28 — the hire-bill deduction is a line, and `netPayable` is recomputed

FR-003 and FR-004. A deduction is a row referencing the exception and the bill, and `HireBill.netPayable`
is recomputed from `grossAmount`, `tdsAmount` and the deductions — not decremented in place.

Decrementing would lose the audit: a vendor disputing a bill is owed the arithmetic, and a bill whose
net was reduced by an `UPDATE` cannot produce it. Recomputing also makes FR-010's reversal a deletion of
a line rather than an inverse adjustment that has to be got exactly right.

**A bill already `paid` cannot take a deduction.** The recovery moves to the next bill for that
equipment and vendor, or waits for one. Adjusting a paid bill would change a figure somebody has already
transferred against.

### D29 — the operator recovery never reaches payroll unapproved, and it reuses the advance path

FR-005 to FR-007. The recovery is raised against the operator, approved through feature 016's spine, and
only then applied as a named deduction on the payroll line — FR-006 and FR-007 read together.

It reuses `SalaryAdvance`'s recovery mechanism rather than introducing a parallel one, because that path
already handles the two things that make salary recovery difficult: instalments, and a recovery larger
than the month's net. What it must **not** inherit is the advance's meaning — this is a recovery for
loss, not money lent — so it is a distinct record that settles through the same machinery, and the
payroll line names it as a fuel recovery.

### D30 — the recovery cap was answered on 2026-10-02, and is built

**Amended 2026-10-04.** This entry said the cap was open; it has not been open since 2026-10-02. The
client's answer was *half that month's wages* — and, decisively, **shared with every other deduction
on the payslip** rather than a separate 50% of its own, because a rule capping the fuel recovery
alone would satisfy itself while the payslip's combined deductions passed the statutory limit. It is
implemented in `src/payroll/engine/deduction-ceiling.ts` (FR-007a to FR-007c), configured per company
through `CompaniesService.getDeductionCeilingPercent`, and bounded at 50 by the database so no caller
has to defend against an unlawful value. Anything above the ceiling carries to the next month and is
never written off quietly.

The text below is kept as the record of how it was planned while open, because the ordering argument
it makes is the reusable part. **It is not a live open question.** Left uncorrected, it is the kind of
stale marker that gets reported to a client as outstanding work two days after it shipped — which is
exactly what happened to feature 019's cash-entry phase, and is corrected there on the same date.

The one `[NEEDS CLARIFICATION]` that was in this spec is the cap on operator salary recovery. It was
the client's decision and was answered on 2026-10-02.

Per the 2026-09-29 decision to plan open questions and phase them last: the recovery is built without a
cap in Phase 6, and Phase 7 adds the cap as a company setting once the figure is known. Building it
uncapped first is safe **only because FR-006 holds** — nothing reaches payroll without approval, so an
unreasonable recovery is refused by a person before it is deducted from one.

That is the specific reason this ordering is acceptable here and would not be elsewhere. If FR-006 were
not already required, an uncapped recovery would be the wrong thing to build first.

### Phases

| Phase | Work | Requirements |
|---|---|---|
| 5 | `FuelVarianceException` + RLS, raised from existing alerts, review and dismissal with author and reason | FR-001, FR-002, FR-008, FR-009 |
| 6 | Hire-bill deduction line, `netPayable` recomputation, operator recovery raised and approved through the spine, applied as a named payroll deduction, reversal | FR-003 to FR-007, FR-010 |
| 7 ⚠️ | The recovery cap as a company setting — **rests on the client's answer** | the open marker |

Phase 5 is inert with respect to money: it adds a review surface over alerts that already exist.
Phase 6 is where a figure first moves, and it is gated on feature 016's chain, which is complete.

### Constitution re-check

| Principle | Assessment |
|---|---|
| **I. Schema-per-module boundaries** | `FuelVarianceException` and the deduction line go in `plant`, beside `FuelEntry` and `HireBill`. The payroll recovery is written through the payroll module's service, never by a cross-schema write. |
| **III. Centralized configuration** | The cap (Phase 7) is a stored company setting with a config default, following D19's precedent for the accuracy maximum in this same feature. |
| **IV. Multi-tenant isolation** | Both new tables get `ENABLE` + `FORCE` RLS with an explicit `WITH CHECK`, proved with the `NOSUPERUSER NOBYPASSRLS` probe. |
| **VI. Observability & safe migrations** | Both tables additive, no backfill. `varianceAlert` and `variancePercent` are untouched — FR-017. |

### Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| A deduction is raised against a paid bill | A transferred figure changes after the fact | D28 refuses it and carries the recovery to the next bill |
| An operator recovery reaches payroll unapproved | Money taken from someone's wages with no decision behind it | FR-006 is a spine gate, not a check in the payroll service; the recovery has no path to a payroll line except through an approved item |
| The same exception is recovered twice — once from the hirer, once from the operator | Double recovery for one loss | FR-002's attribution is exclusive; the exception carries one attribution and the deduction references the exception |
| An exception is recovered and the underlying reading is then corrected | A recovery with no basis | Reversal (FR-010) exists for exactly this and records who reversed it |

### Phase status

**Next**: `/speckit-tasks` for phases 5-7. Phases 1-4 (the geofence half, 41 tasks) are not started and
are independent — the two halves of this feature share a spec and no code.
