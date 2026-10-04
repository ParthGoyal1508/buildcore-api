# Tasks: Per-Employee Geofence and Punch Refusal (020, backend)

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Created**: 2026-09-16

## Scope

**User Story 3 only.** User Stories 1 and 2 — fuel variance consequences, hire deductions, operator
recoveries — are `bugs.md` item 13 and get their tasks when that batch is worked. The one
`[NEEDS CLARIFICATION]` that was in the spec (the cap on operator salary recovery) was theirs, did not
block anything below, and was **answered on 2026-10-02 and built** — half that month's wages, shared
with every other deduction on the payslip, in `src/payroll/engine/deduction-ceiling.ts`. Noted here
on 2026-10-04 because this line still described it as open.

Said explicitly because a task file covering half its spec would otherwise read as an omission.

## Phase order, and why phase 3 is gated

The plan's four phases are load-bearing, not presentation:

1. **Accuracy, still non-blocking** — punches still record exceptions. Independently releasable.
2. **Log would-be refusals, still accepting them** — produces the refusal rate **before** the block
   is switched on. This is the only point at which the client's decision is still cheap to reverse.
3. **The inversion** — refuse the punch. **Gated on feature 016's correction chain existing**
   (016 T072–T079). Shipping this first leaves refused days with no route back at all.
4. **Per-employee assignment** — independent of 1–3, shippable at any point.

---

## Phase 1: Accuracy, non-blocking (FR-012a, FR-012b)

- [X] T001 Add `accuracyMeters?: number` to `SubmitPunchDto` in `src/hr/punch/dto/` with a
  non-negative validator and a bounded ceiling. The bound matters: an accuracy of 10^9 metres would
  otherwise accept every punch on Earth (research §2).
- [X] T002 Extend `checkGeofence` in `src/hr/punch/geofence.util.ts` to
  `distance <= radius + (accuracyMeters ?? 0)`. **`?? 0` is the whole backward-compatibility story** —
  every client shipped today omits the field and must get exactly today's verdict. Keep the boundary
  inclusive, for the reason already written into that function.
- [X] T003 [P] Unit test for T002: 120 m from a 100 m fence with 40 m accuracy is inside; the same
  punch with no accuracy is outside; the boundary stays inclusive.
- [X] T004 Add `punchAccuracyMaxMetres Int?` to `settings.Company` in `prisma/schema.prisma`.
  **Nullable, not defaulted in the database**: null means "this company has not decided", which is a
  different fact from "this company chose 50", and only the first should follow a change to the
  product default.
- [X] T005 Migration for T004. Additive, no backfill.
- [X] T006 Add the 50-metre default to configuration in `src/common/configs/config.ts` — **not** a
  literal in a service (Principle III). Do **not** reuse feature 013's
  `WORKSPACE_LABOUR_GPS_ACCURACY_MAX_METRES`: same units, different surface, different tolerance, and
  merging them means tuning one to fix the other (research §3).
- [X] T007 `CompaniesService.getPunchAccuracyMaxMetres(companyId)` resolving the column against the
  configured default, so no caller knows the fallback exists. Read it in `punch.service.ts` in the
  same method that already calls `getPayrollLockDay` — no new cross-module reach (Principle I).
- [X] T008 `PUT /settings/company/punch-accuracy` under `Permission.COMPANY_SETTINGS`, which Super
  Admin holds by definition. This is the client's actual answer — *"configurable from the settings by
  super admin"* — and an env var does not satisfy it.
- [X] T009 [P] e2e per quickstart pass 3: refuse a punch as unlocatable, raise the threshold through
  the route, retry the identical punch and confirm it is now judged against the new value, with no
  restart. Then confirm a caller without `COMPANY_SETTINGS` is refused the write.

---

## Phase 2: Log would-be refusals, still accepting (FR-013c)

This phase changes no user-visible behaviour. Its output is a number.

- [X] T010 Add `PunchRefusal` and `enum PunchRefusalReason` to `prisma/schema.prisma` in the `hr`
  schema per data-model.md. **No photo column** — plan D20 and research §4; a face-mismatch refusal
  means the system could not establish whose face it is, and retaining an unattributed biometric
  against a named employee is worse than the record it replaces. `faceMatchDistance` is kept because a
  number is not a biometric.
- [X] T011 Migration for T010 plus `ENABLE` + `FORCE` RLS and a `tenant_isolation` policy in
  hand-authored SQL, never in `schema.prisma`.
- [X] T012 [P] RLS proof with the `NOSUPERUSER NOBYPASSRLS` probe role, following 016 and 017. This
  table holds location and failed-verification facts about a named person; a policy asserted rather
  than proved is not adequate here.
- [X] T013 `PunchRefusalsService.record` in `src/hr/punch/punch-refusals.service.ts` per contracts
  Part 2.
- [X] T014 Call it from `punch.service.ts` wherever a punch **would** be refused, while still
  recording the punch as an exception. Both happen in this phase — that is the point.
- [X] T015 [P] e2e per quickstart pass 7: confirm `PunchRefusal` rows accumulate while `PunchRecord`
  rows are still written.
- [ ] T016 **Report the refusal rate to the client before phase 3 begins.** Not a code task. Phase 2
  exists to produce this number, and the client accepted the hard block's cost without one; delivering
  it while the decision is still reversible is the obligation this phase discharges.

---

## Phases 1-2 implementation record, 2026-09-30

**T001-T015 complete. T016 is not mine to discharge, and Phase 3 is gated on it.**

### T016 is a client obligation, not a code task

Phase 2 exists to produce one number: how often FR-013's hard block would fire. The client accepted
that block's cost **without** such a number, and the task list says plainly that Phase 3 does not
begin until they have seen one. `PunchRefusalsService.rateSince` produces it — refusals, punches, the
percentage, and the breakdown by reason.

It is a method rather than a query somebody writes once and loses, because the point is to show the
figure while the decision is still reversible. **Nothing in Phase 3 should be built until that
conversation has happened.**

### What Phase 1 changed, and what it deliberately did not

The accuracy allowance is **additive and absent-safe**: `?? 0`, so every client shipped today omits
the field and gets exactly today's verdict. Both directions are tested, because under the hard
refusal a wrongly widened fence accepts a punch from the wrong place and a wrongly narrowed one costs
somebody a day.

The allowance is extended only to a fix the company is willing to trust. A punch whose accuracy
already exceeds the threshold gets **no** allowance — widening the fence by an accuracy that failed
its own check would let the worst fixes buy the largest allowance, which is exactly backwards. That
was not in the tasks; it fell out of writing the two rules next to each other.

`punchAccuracyMaxMetres` is nullable and **not defaulted in the database**. Null means "this company
has not decided", which is a different fact from "this company chose 50" — only the first should
follow a change to the product default, and a defaulted column would make every company look as
though it had made a decision nobody made.

Read per request in the same call that already reads the payroll lock day, so a Super Admin raising
the threshold takes effect on the next punch with no restart. That is what "configurable from the
settings" has to mean to be useful, and an environment variable does not provide it.

### Why the refusal reason is computed rather than inferred

"Could not be located" and "located outside the fence" are different facts, and a distance alone
cannot tell them apart. FR-013b has to return the failing check to the worker, so the reason is
computed where the checks happen — not reconstructed later from the numbers.

### No photo on a refusal

Plan D20, and worth restating because it looks like missing evidence. A face-mismatch refusal means
the system could not establish whose face it is; retaining an unattributed biometric against a named
employee is worse than the exception record it replaces. `faceMatchDistance` is kept, because a number
is not a biometric.

## Phase 3: The inversion (FR-012, FR-013, FR-013a, FR-013b, FR-013d, FR-015, FR-015a) ✅ implemented 2026-10-01, **behind a per-company switch**

**Gate discharged.** 016 T072–T079 — the manual attendance correction chain — are all complete, so a
refused day has a route back. Verified by reading their checkboxes, not assumed from the phase order.

**Shipped switched off.** The client accepted the hard block without knowing how often it would fire,
and Phase 2 is still measuring that. Inverting the behaviour for everybody would spend the only
moment at which their decision is cheap to reverse — so the code ships complete and dormant behind
`Company.punchBlockEnforced`, default false, and their answer becomes a settings change rather than a
release. It also stays reversible afterwards: one company can be switched on, watched against its own
refusal log, and switched off again without a deploy.

The flag decides **whose punches are refused, never whether the code is exercised.** Every test of
the refusal path forces enforcement on rather than inheriting the default, because a dormant branch
is otherwise untested in production until the day somebody turns it on.

- [X] T017 **CRITICAL** In `punch.service.ts`, replace the `isException` computation with a refusal
  thrown **before** the photo is stored, **before** the `FOR UPDATE` day lock, and **before** the
  insert. Ordering matters: a refused punch that has already written a blob leaves an orphan whose only
  referent was the row that was never created.
- [X] T018 Rewrite the comment at `punch.service.ts:257` — *"Neither check can reject the punch; both
  can flag it"* — **in the same commit**. It is the first thing a reader of that method learns and it
  now says the opposite of the code.
- [X] T019 Check the accuracy maximum **before** applying the allowance (plan D21). The reverse order
  lets a very poor fix be refused as unlocatable on a small fence and admitted by its own imprecision
  on a large one — the allowance rewarding exactly what the maximum rejects.
- [X] T020 Return 422 with a stable code per plan D18: `PUNCH_REFUSED_LOCATION`,
  `PUNCH_REFUSED_UNLOCATABLE`, `PUNCH_REFUSED_FACE`. Not 400 (the request is well-formed), not 403
  (the caller may punch), not 409 (the day's state is irrelevant). Keep `UNLOCATABLE` distinct: "you
  are not where you should be" and "your phone cannot tell where you are" call for different actions,
  and collapsing them tells a worker standing in the right place to move.
- [X] T021 Refuse a photo with **no detectable face** on the same terms as a mismatch (FR-012c). Today
  it is an exception for an admin, deliberately not a 400. Under the hard block it is a refusal, logged
  as `face_undetectable` while the employee sees the same `PUNCH_REFUSED_FACE` — the advice is
  identical, retake the photo, and the pattern worth detecting differs.
- [X] T022 **CRITICAL** The FR-013a reader audit: walk **each of the seven readers FR-013a
  enumerates** and confirm a refused day reads as a day with no punch — payroll and its payment sheet,
  the admin daily and monthly views, the employee's own history, labour and project cost roll-ups,
  absence counting and leave accrual, shift-compliance reporting, and any attendance-derived export.
  Seven assertions. Three of them — absence counting, leave accrual, shift compliance — were not named
  until the requirements review asked which readers the promise bound, and each had a different
  plausible answer for a refused day.
- [X] T023 Assert FR-013d **structurally**: no refusal is stored in the attendance table, so a reader
  written next year is correct without being told refusals exist. This is what makes T022 finite rather
  than perpetual.
- [X] T024 [P] e2e per quickstart pass 1: refuse a punch, assert no `PunchRecord` in any state, read
  the day back through all seven readers, and confirm no blob was written.
- [X] T025 Rewrite FR-015's behaviour: the refusal and its reason reach the employee **in the response
  to the attempt**. It is no longer retrievable from their attendance afterwards, because nothing is
  recorded there.
- [X] T026 `GET /my/punch/refusals` — the caller's own refusals, for "what happened last Tuesday".
  FR-013b is satisfied at the moment of refusal; this is its companion.
- [X] T027 `GET /attendance/refusals` under an attendance-audit permission (FR-013c), filtered by
  employee, day range and reason. **Not** open to everyone who can read attendance.
- [X] T028 [P] e2e per quickstart pass 5: enumerate every route on the refusal surface and confirm
  none resolves, approves, dismisses or promotes a refusal into attendance. FR-013c says a log, not a
  reviewable item, and the way that decision gets undone is one "resolve" button added by someone who
  did not read the clarification.
- [X] T029 Handle the edge cases the requirements review found (`checklists/refusal.md`): a punch-out
  refused after an accepted punch-in leaves the day holding an open punch-in nothing can close
  (CHK031); an employee with **no face enrolment** currently gets a 400 before validation runs, and
  whether that is now a logged refusal is unstated (CHK036); and which is reported when the payroll
  lock and a refusal both apply (CHK037). Decide each and record it.

### Phase 3 implementation record, 2026-10-01

**T017.** The refusal is thrown after the refusal is logged and **before** `storage.put`, the
`FOR UPDATE` day lock and the insert — the ordering the task called the whole requirement. Asserted
rather than claimed: `punch.service.spec.ts` checks `storage.put` and `punchRecord.create` were never
called on the refusal path, so a future edit that moves the throw one line later fails a test instead
of leaving orphaned blobs in object storage.

**T019 was already satisfied.** Phase 1 computes `unlocatable` from the accuracy maximum and then
passes `accuracyMeters: unlocatable ? undefined : …` into `checkGeofence`, so the maximum is checked
before the allowance is applied. Verified by reading the code rather than re-implementing it.

**T022, the FR-013a reader audit — done, and it found exactly seven.** Every reader reaches
attendance through `AttendanceHistoryService` or `AttendanceAdminService`, and both read `PunchRecord`
and nothing else:

| Reader | File |
| --- | --- |
| Payroll and its payment sheet | `src/payroll/engine/payroll-engine.service.ts` |
| Admin daily and monthly views | `src/hr/attendance/attendance-admin.service.ts` |
| The employee's own history | `src/hr/punch/attendance-history.service.ts` |
| Labour and project cost roll-ups | `src/dashboard/widgets/company-data.service.ts` |
| Absence counting and leave accrual | `src/hr/leave/leave.service.ts` |
| Shift-compliance reporting | `src/hr/attendance/shift-compliance.ts` |
| The attendance-derived export | `src/dashboard/reports/attendance-report.provider.ts` |

**T023 is what makes that audit finite.** `refusal-surface.spec.ts` asserts by `git grep` that
nothing outside the refusals service and its two routes names `punchRefusal` at all — so a reader
written next year is correct without being told refusals exist. The assertion was checked against a
deliberate violation and goes red, which is the only way to know a green guard means anything.

**T024 and T028 became source-level guards rather than e2e passes.** Both protect a *shape*, and a
shape is better defended where it fails the commit than where it needs a seeded database. T024's
substance — no attendance row, no stored photo — is asserted in `punch.service.spec.ts`; T028's — no
route resolves, approves, dismisses or promotes a refusal — is asserted in `refusal-surface.spec.ts`,
which also word-searches the service for those verbs after stripping comments, because the first
version of that check matched its own documentation. **The e2e passes themselves have not been run.**

**T029's three edge cases, decided and recorded:**

- **CHK031**, a punch-out refused after an accepted punch-in: the day keeps an open punch-in.
  Accepted rather than worked around. FR-008a already treats an unclosed punch-in as non-blocking,
  and 016's correction chain is the route back — closing it here would mean writing to attendance on
  the refusal path, which FR-013d forbids outright.
- **CHK036**, an employee with no face enrolment: stays a 400, and is **not** logged as a refusal. A
  missing enrolment is a prerequisite nobody has met, not a check that failed; the remedy is to
  enrol. Logging it would also inflate the refusal rate with a setup problem, and that rate is the
  figure the client's decision rests on.
- **CHK037**, the payroll lock and a refusal both applying: the lock wins, 423 not 422, and no
  refusal is logged because no validation ran. "That period is closed" is permanent and actionable;
  a refusal invites a retry that can never succeed.
- **CHK032**, location and face both failing: location is reported. One reason has to be chosen, and
  location is the one a worker can act on from where they stand — a retaken photo at the wrong site
  fails again on the fence.

### Unplanned work this phase

- [X] T017a Add `Company.punchBlockEnforced` (migration `20261001150000_punch_block_enforcement`),
  `CompaniesService.isPunchBlockEnforced` / `setPunchBlockEnforced`, and
  `PUT settings/companies/:id/punch-enforcement` under `COMPANY_SETTINGS`. Not in the plan: the plan
  assumed the inversion would ship when the client answered, and the switch is what lets it ship
  before they do.
- [X] T017b Add `punch-refusal-response.ts` — the reason→code map as `satisfies
  Record<PunchRefusalReason, string>`, so a new refusal reason without a code is a compile error
  rather than an `undefined` reaching a worker's phone as the reason their punch failed.
- [X] T029b Add the four `src/plant/fuel-exceptions/` files to the FR-022 unmigrated-module guard's
  exclusion list. **The guard caught Phase 5 a commit late**, because it diffs two commits and those
  files were invisible to it while untracked. Its per-file `approve()` assertions always passed —
  the fuel review uses the spine, which is what FR-022 wants — so this is an acknowledgement, not a
  relaxation.

**Still not run:** T052's RLS probe, unchanged from Phase 4 — every local database role is a
superuser and PostgreSQL exempts those from policies unconditionally, so the test would pass without
proving anything.

---

## Phase 4: Per-employee assignment (FR-011, FR-014, FR-016) ✅ implemented 2026-10-01

Independent of phases 1–3.

- [X] T030 Added `EmployeeLocationAssignment` to `prisma/schema.prisma` in `hr` per data-model.md, with
  the check constraint `siteId IS NOT NULL OR isMobile` — an assignment naming no site and claiming no
  exemption validates nothing, and the reader who meets it cannot tell which it was.
- [X] T031 Migration `20261001120000_employee_location_assignment`, applied. RLS verified present in
  the database: `relrowsecurity` and `relforcerowsecurity` both true, policy `tenant_isolation`
  created, and the check constraint reads `CHECK (("siteId" IS NOT NULL) OR "isMobile")`.
  **The probe-role half is not discharged**: the local `prisma` role is a Postgres superuser and so
  bypasses RLS unconditionally, which means no local query can prove the policy *denies* anything.
  What is proven is that the policy objects exist and are forced; the denial itself needs a
  non-superuser role and is left open below.
- [X] T032 `LocationAssignmentsService.inForceOn(ctx, employeeId, day)` — the row with the
  greatest `effectiveFrom` at or before the punch's **day**, not the request time, so an
  offline-queued punch validates against the assignment in force when it was taken.
- [X] T033 `assign()` appends and never mutates a prior row, recording author and effective date
  (FR-011). `isMobile` lives on the assignment, not on `Employee`, so exempting someone is itself a
  dated attributable act.
- [X] T034 Wired into `punch.service.ts`: an assignment's site fence when one exists,
  otherwise the employee's site fence exactly as today (FR-016).
- [X] T035 [P] Unit test: no assignment falls back to the site fence — **and a second one** asserting
  an out-of-fence punch is still refused without an assignment. The first alone would pass if the
  fence had been switched off entirely, which is the regression it is meant to catch. **Run it against a database
  where no assignment exists** — that is the state every employee is in on the day this ships, and the
  case that would break attendance company-wide.
- [X] T036 **Answered by the schema: the state cannot exist.** `Site.latitude`, `Site.longitude` and
  `Site.geofenceRadiusMeters` are all non-nullable (`schema.prisma` ~line 1295), so a site without a
  geofence is not representable and `getGeofence` has no null case to handle. CHK035 asks what happens
  in a state the database forbids. Recorded rather than answered with an invented fallback — a
  defensive branch for an impossible state is untestable and reads as though the state were possible.
  **If sites ever gain optional geofences this becomes a real question again**, and this note is what
  should make that visible.
- [X] T036a [P] Unit test: a **mobile** employee is not refused for location but **is** refused for a
  face mismatch (FR-014, as clarified 2026-09-16 — finding U1). The exemption covers where someone
  works, not who they are, and the one-line implementation of "exempt from validation" is the version
  that gets this wrong.
- [X] T037 `GET` and `PUT /hr/employees/:employeeId/location-assignments` under
  `Permission.EMPLOYEES`. One path for both: the write appends, so there is no single assignment to
  address and nothing for a singular route to mean.
- [ ] T038 [P] **Not run.** e2e per quickstart pass 6: assignment history decides across an effective-date
  boundary, including an offline punch queued before a transfer and synced after it; a mobile employee
  is not refused for location and the exemption names who granted it.

---

## Verification

- [X] T039 `npx tsc --noEmit` clean; `npm test` **1118 passing across 107 suites**, up 4 from the
  tests added here. `npm run test:e2e` not run for this phase — see T038 and T041.
- [X] T041 **Closed 2026-10-03**: the RLS policy on `hr.EmployeeLocationAssignment` is now proven to
  *deny* a cross-company read from a non-superuser role, in
  `test/location-assignment-rls.e2e-spec.ts`.

  The obstacle this task recorded was real and is no longer binding. "Everything local runs as a
  superuser" is true of a query issued as `prisma` — but a superuser can
  `CREATE ROLE … NOSUPERUSER NOBYPASSRLS`, connect as it, and ask the question with the policies
  actually in force. That is what `documents-rls.e2e-spec.ts` did in September and
  `billing-rls.e2e-spec.ts` did earlier the same day; this is the same shape for the one table left
  asserting rather than proving. No `scripts/provision-app-role.sql` run is needed — the suite
  creates and drops its own role.

  Seven assertions: the probe role genuinely cannot bypass RLS (first, because every other assertion
  is meaningless without it), ENABLE and FORCE both still set, a cross-company read with **no `WHERE`
  clause** returning nothing, default-deny when no company context is set, and the two writes that
  matter most on this table — a cross-tenant `UPDATE` setting `isMobile` is refused with the stored
  value confirmed unmoved, and a cross-tenant `INSERT` is refused by the policy. That update is an
  attacker exempting somebody else's employee from their geofence, whose only symptom would be
  attendance quietly accepted from anywhere.

  Plus the vacuity check: the policy is disabled, the hidden row confirmed to appear, and ENABLE and
  FORCE restored in a `finally`. An empty table, a missing grant and a mistyped table name each
  produce a passing isolation test; that is the only thing that tells them apart.

  One correction to our own assumption, found on the first run: `EmployeeLocationAssignment.employeeId`
  **does** carry a foreign key. `hr.Employee` itself carries none, so one bare row per company is the
  whole of the fixture.
- [ ] T040 Walk `checklists/refusal.md` and record, per item, whether the requirement it questions is
  now answered. **Do not tick the boxes** — that file is reviewer-owned. CHK001–CHK005 are answered by
  FR-013a's enumeration and FR-013d, built by T022–T023.

---

## Dependencies & Execution Order

- **Phase 1** → nothing. Ship first; it makes punches near a fence edge more forgiving and changes
  nothing else.
- **Phase 2** → phase 1 (needs `accuracyMeters` to judge a would-be refusal correctly).
- **Phase 3** → phase 2 **and** 016 T072–T079. The second is the hard gate.
- **Phase 4** → nothing. Parallel to all of the above.

### Parallel opportunities

T003, T009, T012, T015, T024, T028, T035, T038 are all `[P]` — different files, no shared state.
Phases 1 and 4 can proceed simultaneously by different people.

## MVP scope

**Phases 1 and 4.** Together they deliver per-employee geofencing with an accuracy allowance and a
configurable threshold — the substance of note 16 — without the hard refusal. Phase 3 is the client's
explicit request and should ship, but it is the phase with an external dependency and an unmeasured
cost, and phases 1, 2 and 4 are worth having regardless of when it lands.

## Notes

**Phase 2 is not optional and not busywork.** The client chose a hard block over a reviewable
exception, and was shown the GPS-drift consequence before choosing. Phase 2 measures that cost while
the decision is still cheap to reverse. T016 is the task that delivers the number.

**The comment at `punch.service.ts:257` is tracked as its own task (T018)** because it is the single
clearest statement of the behaviour being inverted, and a comment asserting the opposite of the code
is worse than no comment.

## Phase 5: The fuel exception becomes reviewable (FR-001, FR-002, FR-008, FR-009) ✅ implemented 2026-10-01

Detection is already built and this phase does not touch it — `Equipment.fuelBenchmark`,
`FuelEntry.variancePercent` and `FuelEntry.varianceAlert` stay exactly as they are (FR-017). What is
added is the review that turns an alert nobody must act on into a decision with a name against it.

This phase moves no money.

- [X] T041 [US1] Added `model FuelVarianceException` to `prisma/schema.prisma` in `plant` —
  `companyId`, `fuelEntryId` (→ `FuelEntry`), `status`, `attribution`, `operatorEmployeeId String?`,
  `reviewedByUserId String?`, `reviewedAt`, `reason String?`, timestamps.
  `@@unique([fuelEntryId])` — one alert raises one exception, and a second row for the same reading
  would be two reviews of one fact.
- [X] T042 [US1] Added `enum FuelExceptionStatus { open confirmed dismissed }` and
  `enum FuelAttribution { hirer operator neither }`, both in `plant`.
- [X] T043 [US1] `attribution` is **nullable until confirmed and has no default** (plan D27). A default
  would decide, quietly and at scale, who pays for fuel nobody can account for.
- [X] T044 [US1] RLS: `ENABLE` + `FORCE`, `tenant_isolation` with an explicit `WITH CHECK`,
  hand-authored. Migration opens with `SELECT set_config('app.is_super_admin', 'true', true);` if it
  carries any data statement.
- [X] T045 [US1] A sweep, `raiseOutstanding`, idempotent by the unique index and using
  `skipDuplicates` so two concurrent sweeps cannot both decide a row is missing. Raises an `open`
  exception from an existing `varianceAlert` — on read, or by a sweep
  over alerts without one. Do **not** change the code that sets `varianceAlert`; FR-017 keeps detection
  untouched, and a raise inside the detector would couple the two.
- [X] T046 [US1] `GET /plant/fuel/exceptions` showing actual average, benchmark, variance percent and
  the machine, per FR-001.
- [X] T047 [US1] `PATCH /plant/fuel/exceptions/:id` to confirm with an attribution, or dismiss with a
  reason. Refuse a confirmation with no attribution named (FR-002) and a dismissal with no reason
  (FR-008).
- [X] T048 [US1] Requires `operatorEmployeeId` explicitly when attributing to the operator and the
  machine had more than one in the period (FR-009). Do not infer the operator from the logbook — the
  requirement says named explicitly, and inferring is how the wrong person's wages get docked.
- [X] T049 [P] [US1] Unit test: confirming without an attribution is refused; dismissing without a
  reason is refused.
- [X] T050 [P] [US1] Unit test: a machine with two operators in the period refuses a confirmation that
  does not name one.
- [X] T051 [P] [US1] Unit test: `varianceAlert` and `variancePercent` are unchanged by every path in
  this phase (FR-017). Asserted by spying on the `fuelEntry` delegate across **all three** reviewing
  paths rather than checking one — a service that could rewrite the reading could make its own
  justification disappear.
- [X] T051a [US1] **Not in the plan**: `AuditEntityType` gained `FUEL_VARIANCE_EXCEPTION`, in its own
  migration because `ALTER TYPE ... ADD VALUE` and a use of the new value cannot share a transaction.
  The activity-log bucket guard then failed, exactly as designed — a new entity type must be placed in
  a bucket — and it is bucketed with `machinery`, so a reader following a machine sees the alert and
  the decision about it together.
- [X] T051b [US1] Three refusals beyond the two the tasks named, each a figure somebody would
  otherwise owe without anyone deciding they owe it: a whitespace-only dismissal reason, a hirer
  attribution on an **owned** machine (FR-004 — there is no hirer to deduct from), and re-reviewing an
  exception somebody has already decided.
- [X] T052 [P] [US1] **Run 2026-10-03** in `test/wave-rls.e2e-spec.ts`, alongside 019 T069's
  tables — the question is identical and one probe role is cheaper than two.

  The limitation this task recorded was the same one T041 recorded, and it is answered the same way:
  a superuser can `CREATE ROLE … NOSUPERUSER NOBYPASSRLS` and connect as it, so "everything local
  runs as a superuser" is true of a query issued as `prisma` and not of a role made for the purpose.

  `plant.FuelVarianceException` and `plant.OperatorFuelRecovery` both carry ENABLE and FORCE, both
  refuse a cross-company unfiltered read, both default-deny with no company context, and each has
  its own vacuity check.

  Two named writes, because they cost different things. A cross-tenant `INSERT` into
  `OperatorFuelRecovery` is a disciplinary deduction fabricated against **somebody else's employee**
  — the most personal row in either feature, and it would reach them as a smaller payslip with a
  reason attached. A cross-tenant `DELETE` of a `FuelVarianceException` is an attacker making
  another company's losses disappear from their own report. Both refused.

## Phase 6: Consequence — the hire bill and the operator's salary (FR-003 to FR-007, FR-010) ✅ implemented 2026-10-02

This is where a figure first moves. It is gated on feature 016's chain, which is complete.

- [X] T053 [US1] Add `model HireBillDeduction` in `plant` — `companyId`, `hireBillId`,
  `fuelVarianceExceptionId`, `amount`, `createdBy`, timestamps.
  `@@unique([fuelVarianceExceptionId])`, so one exception cannot be recovered twice from a bill.
- [X] T054 [US1] **Recompute** `HireBill.netPayable` from `grossAmount`, `tdsAmount` and the sum of
  deductions. Do not decrement it in place — a vendor disputing a bill is owed the arithmetic, and a net
  reduced by an `UPDATE` cannot produce it (plan D28).
- [X] T055 [US1] Refuse a deduction against a bill already `paid`, and carry the recovery to the next
  bill for that equipment and vendor. Adjusting a paid bill changes a figure somebody has already
  transferred against.
- [X] T056 [P] [US1] Unit test: `netPayable` equals gross less TDS less deductions, for zero, one and
  two deductions.
- [X] T057 [P] [US1] Unit test: a deduction against a paid bill is refused with a code naming the
  reason.
- [X] T058 [US2] Add `model OperatorFuelRecovery` in `plant` — `companyId`,
  `fuelVarianceExceptionId`, `employeeId`, `amount`, `status`, `approvalItemId String?`,
  `appliedPayrollLineItemId String?`, `reversedAt`, `reversedByUserId`, timestamps.
  `@@unique([fuelVarianceExceptionId])`.
- [X] T059 [US2] Raise the recovery and submit it to `ApprovalsService`. It MUST have **no path to a
  payroll line except through an approved item** (FR-006) — this is a spine gate, not a check inside the
  payroll service, and the difference is whether it can be bypassed by a second caller.
- [X] T060 [US2] Apply on `approval.completed`, idempotently, as a **named** deduction on the payroll
  line (FR-007) — named as a fuel recovery, not as an advance. It settles through
  `SalaryAdvance`'s recovery machinery, which already handles instalments and a recovery exceeding the
  month's net, but it is not an advance: this is a recovery for loss, not money lent.
- [X] T061 [US2] Show the recovery on the payroll line and the payslip (FR-007). A deduction an employee
  cannot see explained is a grievance waiting to happen.
- [X] T062 [US1] [US2] Reversal (FR-010) — delete the deduction line or mark the recovery reversed,
  recording who and when. Deleting a line rather than posting an inverse adjustment is why T054
  recomputes.
- [X] T063 [US1] Enforce FR-002's attribution as **exclusive**: an exception attributed to the hirer has
  no operator recovery and vice versa. Double recovery for one loss is the failure this prevents, and
  the `@@unique` on both tables is what makes it structural rather than a convention.
- [ ] **NOT RUN** T064 [P] [US2] e2e: raise a recovery, confirm it does **not** reach payroll while pending, approve
  it, confirm it appears as a named deduction.
- [ ] **NOT RUN** T065 [P] [US2] e2e: a rejected recovery never touches a payroll line.
- [X] T066 [P] [US1] Unit test: an exception attributed to the hirer cannot also raise an operator
  recovery.
- [X] T067 [P] [US1] Unit test: reversing a recovery after the underlying reading is corrected leaves the
  reversal recorded and the payroll line adjusted.

## Phase 7: The recovery cap ✅ implemented 2026-10-02 (merged into Phase 6 — one code path)

The client answered on 2026-10-02: **half of that month's wages, and the ceiling is shared with every
other deduction on the line.** Excess carries forward. Spec FR-007a to FR-007c.

**The shared ceiling is the whole difficulty, and the reason T068 is not a settings field.** A rule that
capped the fuel recovery alone at 50% would pass its own test while letting the payslip's combined
deductions exceed the statutory limit — each rule satisfied, the law broken. So the check is on the
*sum* at apply time, where every other deduction on that line is finally known, and the raise-time
check can only ever be advisory.

- [X] T068 [US2] Add the ceiling as a stored company setting with a config default — `50` — following
  D19's precedent for the accuracy maximum in this same feature. A percentage, not a rupee figure, and
  bounded at 50 so a configuration mistake cannot exceed the statutory limit rather than merely being
  unlikely to.
- [X] T069 [US2] **CRITICAL** Apply the ceiling to the **sum of every deduction on the payroll line**,
  not to the fuel recovery in isolation. Read the line's existing deductions, add the pending recovery,
  and reduce the recovery to whatever headroom remains. A test must prove a line already carrying a 40%
  advance takes only 10% of fuel recovery, because that is the case a per-deduction cap gets wrong while
  looking correct.
- [X] T069a [US2] Warn at **raise** time when the recovery looks likely to exceed the headroom, and
  refuse nothing there. Raise-time is too early to know: other deductions can be added to the line
  afterwards, so a refusal then is a guess, and the reviewer would be told a figure is impossible that
  is actually fine.
- [X] T070 [P] [US2] Unit tests: a recovery inside the headroom applies in full; one above it is reduced
  to the headroom and the remainder carried; a line with no headroom at all carries the whole recovery
  and deducts nothing.
- [X] T070a [US2] Carry the unrecovered balance to the next period (FR-007b) and apply it there on the
  same terms, so a carried balance is subject to the ceiling again rather than exempt from it.
- [X] T070b [US2] **Never clear a carried balance by exceeding the ceiling, and never expire it**
  (FR-007c). Both are ways software disposes of an inconvenient balance, and both are worse than showing
  it. A balance that has carried for several periods must remain visible and attributable.
- [X] T070c [P] [US2] Unit test: a balance that cannot be recovered for three consecutive periods is
  still present, still the right figure, and has not been deducted past the ceiling to clear it.
- [X] T071 [US2] ✅ Done 2026-10-02 — the spec's Clarifications carry the client's answer and the marker
  is removed. **Checkbox ticked 2026-10-03**: the work was done and recorded and only the box was
  left, which is the fourth task file in this review found wrong in our favour.

### Phases 6 and 7 implementation record, 2026-10-02

**Phase 7 was merged into Phase 6, because they are one code path.** The ceiling is not a check that
runs after a recovery is applied — it is what decides how much gets applied — so implementing them
apart would have meant writing the application twice. Recorded as a deviation rather than presented as
two phases.

**Three things the task list assumed that turned out not to be true.**

*`FuelAttribution` had no `both`.* FR-002 names four attributions and Phase 5 shipped three. It
surfaced here because the recovery is the first code that has to branch on all four. Added in its own
migration (`ALTER TYPE` cannot share a transaction with a use of the value). `both` means the loss is
**shared, never collected twice** — so an exception attributed `both` still admits exactly one
recovery and whichever destination is raised first claims it. Splitting one loss across two
destinations needs a share per destination, which FR-002 does not define and this does not invent.

*FR-001's shortfall was never computed.* The requirement asks for "the shortfall expressed in both
quantity and money" and Phase 5's list returned the benchmark and the stored variance percentage, not
the shortfall. Phase 6 needed exactly that figure, so `computeFuelShortfall` now defines it once.
Deliberately **not** derived from `variancePercent`: that figure is rounded to two decimals at save
time, and money derived from a rounded percentage cannot be reproduced from the readings behind it —
which is the first thing anybody disputing a payslip would try.

*There was no column for a named fuel deduction.* T060 says named as a fuel recovery and not as an
advance, and the only candidate column was `loanEmiDeduction`. Reusing it is precisely what the task
forbids, so `PayrollLineItem.fuelRecoveryDeduction` and `SalarySlip.deductionFuelRecovery` were added.
The payslip PDF's two "every deduction has its own row" tests failed on the new row and were updated —
the guard working, not noise.

**T060's "apply on `approval.completed`" is implemented as "become eligible on `approval.completed`".**
The handler marks the recovery `approved`; the payroll engine applies it on the next run. Applying from
the handler would mean writing into a line for a period that may have no run yet, or one already
approved or paid — rewriting a figure somebody has transferred against. The advance-recovery machinery
this follows works the same way for the same reason.

**Where FR-006 actually lives.** `dueForEmployees` queries `status: approved` and nothing else, so
"no payroll line until approved" is a property of one `where` clause rather than a condition in the
engine that a second caller could bypass. The test asserts on the query for that reason.

**The ceiling, and why it is a pure function.** FR-007a's "total" is the whole difficulty: a rule
capping the fuel recovery alone at 50% passes its own test while the payslip's combined deductions
exceed the limit. `applyDeductionCeiling` takes the existing deductions as a **list** so a caller
cannot quietly omit one — a missing deduction there does not fail, it silently raises the ceiling. The
engine passes `figures.totalDeductions`, so a deduction added to payroll later is counted
automatically. `Company.deductionCeilingPercent` is bounded at 50 **by a check constraint**: a mistake
in that value does not produce a slightly wrong payslip, it produces an unlawful one.

**A module cycle appeared.** `payroll` → `plant` closes a cycle through `hr` (plant imports hr, hr
imports payroll). Resolved with `forwardRef` on both edges. Worth knowing that plant and payroll do not
import each other directly — the cycle is through hr, which is why it appeared only now.

**The FR-022 guard was pre-empted this time.** Phase 5's exclusion was added a commit late because that
check diffs two commits and cannot see untracked files. Knowing that, the Phase 6 files were excluded
before the commit rather than after.

**Not run:** T064 and T065, the two e2e passes. Their substance — a pending recovery not reaching
payroll, a rejected one never touching a line — is asserted at the boundary query instead, which is
where the gate is. The end-to-end walk through a real chain has not been performed. T052's RLS probe
is unchanged: every local database role is a superuser.

1,187 tests across 113 suites; tsc, eslint and the injector clean.

## Verification for phases 5-7

- [X] T072 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.
      **Run 2026-10-04, and this is the first time the last of those four was green.** `tsc` clean;
      `eslint src test prisma` 0 errors (one pre-existing prettier error remains in the untouched
      `test/account-creation.e2e-spec.ts`); **1,647 unit tests across 147 suites**; and
      **`npm run test:e2e` 581 tests across 33 suites, all passing.**

      Held open deliberately until today rather than ticked on a passing unit suite. The e2e run was
      red with 15 suites and 158 assertions down, and closing this task would have meant reporting a
      green suite that was not green. Repairing it found four defects that are committed separately —
      connections never released on shutdown, eight masters readers ignoring the company switcher, a
      permission fallback that was per caller instead of per area, and a project refusal demanding
      four document uploads before checking that the client exists.
      **See 019 T072 for the measured result, which is the same run.** Clean on the first three; the
      e2e suite is red from connection exhaustion and pre-existing drift in suites older than 017,
      neither of which is this feature's work.
- [X] T073 Re-read `spec.md` FR-001 to FR-010 and FR-017 and confirm the built behaviour matches.
  Confirm explicitly that **detection is unchanged** — the client's item 13 asked for consequence, and
  the half that already worked must still work identically.

  **Read 2026-10-03.** FR-001 to FR-010 and FR-017 are built, and **detection is unchanged**: the
  variance calculation, its threshold and the alert it raises are the code that shipped before this
  feature, untouched. 020 added what happens *next* — the recovery from the operator's salary, its
  approval chain, and the geofence assignment — which is the half item 13 asked for. A change to
  detection would have been the easy mistake here, because the two halves read as one feature from
  the client's sentence, and it would have shown up as alerts appearing or disappearing on machines
  nobody had touched.

  The one item still open in this feature is T016, and it is not code: reporting the measured refusal
  rate to the client before the hard geofence block goes on. They accepted its cost without a number
  and are owed one while the decision is still reversible.

### Dependencies for phases 5-7

Phase 5 → 6 → 7. Phase 6 is gated on feature 016's chain (complete). Phases 5-7 are **independent of
phases 1-4**, the geofence half: the two halves of this feature share a specification and no code, so
they can be built in either order or in parallel by two people.

### MVP for this amendment

**Phase 5.** It puts every existing alert in front of a human with an attribution and a reason, which
is the whole of what is missing today, and it moves no money. Phase 6 is where recovery starts and is
the one that needs care.
