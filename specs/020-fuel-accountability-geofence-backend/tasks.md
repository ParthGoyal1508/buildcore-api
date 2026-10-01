# Tasks: Per-Employee Geofence and Punch Refusal (020, backend)

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Created**: 2026-09-16

## Scope

**User Story 3 only.** User Stories 1 and 2 — fuel variance consequences, hire deductions, operator
recoveries — are `bugs.md` item 13 and get their tasks when that batch is worked. The one open
`[NEEDS CLARIFICATION]` in the spec (the cap on operator salary recovery) is theirs, and does not
block anything below.

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

## Phase 3: The inversion (FR-012, FR-013, FR-013a, FR-013b, FR-013d, FR-015, FR-015a)

**Gated on 016 T072–T079.** Do not start this phase until the manual correction chain exists.

- [ ] T017 **CRITICAL** In `punch.service.ts`, replace the `isException` computation with a refusal
  thrown **before** the photo is stored, **before** the `FOR UPDATE` day lock, and **before** the
  insert. Ordering matters: a refused punch that has already written a blob leaves an orphan whose only
  referent was the row that was never created.
- [ ] T018 Rewrite the comment at `punch.service.ts:257` — *"Neither check can reject the punch; both
  can flag it"* — **in the same commit**. It is the first thing a reader of that method learns and it
  now says the opposite of the code.
- [ ] T019 Check the accuracy maximum **before** applying the allowance (plan D21). The reverse order
  lets a very poor fix be refused as unlocatable on a small fence and admitted by its own imprecision
  on a large one — the allowance rewarding exactly what the maximum rejects.
- [ ] T020 Return 422 with a stable code per plan D18: `PUNCH_REFUSED_LOCATION`,
  `PUNCH_REFUSED_UNLOCATABLE`, `PUNCH_REFUSED_FACE`. Not 400 (the request is well-formed), not 403
  (the caller may punch), not 409 (the day's state is irrelevant). Keep `UNLOCATABLE` distinct: "you
  are not where you should be" and "your phone cannot tell where you are" call for different actions,
  and collapsing them tells a worker standing in the right place to move.
- [ ] T021 Refuse a photo with **no detectable face** on the same terms as a mismatch (FR-012c). Today
  it is an exception for an admin, deliberately not a 400. Under the hard block it is a refusal, logged
  as `face_undetectable` while the employee sees the same `PUNCH_REFUSED_FACE` — the advice is
  identical, retake the photo, and the pattern worth detecting differs.
- [ ] T022 **CRITICAL** The FR-013a reader audit: walk **each of the seven readers FR-013a
  enumerates** and confirm a refused day reads as a day with no punch — payroll and its payment sheet,
  the admin daily and monthly views, the employee's own history, labour and project cost roll-ups,
  absence counting and leave accrual, shift-compliance reporting, and any attendance-derived export.
  Seven assertions. Three of them — absence counting, leave accrual, shift compliance — were not named
  until the requirements review asked which readers the promise bound, and each had a different
  plausible answer for a refused day.
- [ ] T023 Assert FR-013d **structurally**: no refusal is stored in the attendance table, so a reader
  written next year is correct without being told refusals exist. This is what makes T022 finite rather
  than perpetual.
- [ ] T024 [P] e2e per quickstart pass 1: refuse a punch, assert no `PunchRecord` in any state, read
  the day back through all seven readers, and confirm no blob was written.
- [ ] T025 Rewrite FR-015's behaviour: the refusal and its reason reach the employee **in the response
  to the attempt**. It is no longer retrievable from their attendance afterwards, because nothing is
  recorded there.
- [ ] T026 `GET /my/punch/refusals` — the caller's own refusals, for "what happened last Tuesday".
  FR-013b is satisfied at the moment of refusal; this is its companion.
- [ ] T027 `GET /attendance/refusals` under an attendance-audit permission (FR-013c), filtered by
  employee, day range and reason. **Not** open to everyone who can read attendance.
- [ ] T028 [P] e2e per quickstart pass 5: enumerate every route on the refusal surface and confirm
  none resolves, approves, dismisses or promotes a refusal into attendance. FR-013c says a log, not a
  reviewable item, and the way that decision gets undone is one "resolve" button added by someone who
  did not read the clarification.
- [ ] T029 Handle the edge cases the requirements review found (`checklists/refusal.md`): a punch-out
  refused after an accepted punch-in leaves the day holding an open punch-in nothing can close
  (CHK031); an employee with **no face enrolment** currently gets a 400 before validation runs, and
  whether that is now a logged refusal is unstated (CHK036); and which is reported when the payroll
  lock and a refusal both apply (CHK037). Decide each and record it.

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
- [ ] T041 **Open from T031**: prove the RLS policy *denies* a cross-company read of this table from a
  non-superuser role. Everything local runs as a superuser, which Postgres exempts from policies
  unconditionally, so the guarantee is currently asserted by the policy's existence rather than by its
  behaviour. `scripts/provision-app-role.sql` creates the `buildcore_app` role this needs.
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

## Phase 5: The fuel exception becomes reviewable (FR-001, FR-002, FR-008, FR-009)

Detection is already built and this phase does not touch it — `Equipment.fuelBenchmark`,
`FuelEntry.variancePercent` and `FuelEntry.varianceAlert` stay exactly as they are (FR-017). What is
added is the review that turns an alert nobody must act on into a decision with a name against it.

This phase moves no money.

- [ ] T041 [US1] Add `model FuelVarianceException` to `prisma/schema.prisma` in `plant` —
  `companyId`, `fuelEntryId` (→ `FuelEntry`), `status`, `attribution`, `operatorEmployeeId String?`,
  `reviewedByUserId String?`, `reviewedAt`, `reason String?`, timestamps.
  `@@unique([fuelEntryId])` — one alert raises one exception, and a second row for the same reading
  would be two reviews of one fact.
- [ ] T042 [US1] Add `enum FuelExceptionStatus { open confirmed dismissed }` and
  `enum FuelAttribution { hirer operator neither }`, both in `plant`.
- [ ] T043 [US1] `attribution` is **nullable until confirmed and has no default** (plan D27). A default
  would decide, quietly and at scale, who pays for fuel nobody can account for.
- [ ] T044 [US1] RLS: `ENABLE` + `FORCE`, `tenant_isolation` with an explicit `WITH CHECK`,
  hand-authored. Migration opens with `SELECT set_config('app.is_super_admin', 'true', true);` if it
  carries any data statement.
- [ ] T045 [US1] Raise an `open` exception from an existing `varianceAlert` — on read, or by a sweep
  over alerts without one. Do **not** change the code that sets `varianceAlert`; FR-017 keeps detection
  untouched, and a raise inside the detector would couple the two.
- [ ] T046 [US1] `GET /plant/fuel/exceptions` showing actual average, benchmark, variance percent and
  the machine, per FR-001.
- [ ] T047 [US1] `PATCH /plant/fuel/exceptions/:id` to confirm with an attribution, or dismiss with a
  reason. Refuse a confirmation with no attribution named (FR-002) and a dismissal with no reason
  (FR-008).
- [ ] T048 [US1] Require `operatorEmployeeId` explicitly when attributing to the operator and the
  machine had more than one in the period (FR-009). Do not infer the operator from the logbook — the
  requirement says named explicitly, and inferring is how the wrong person's wages get docked.
- [ ] T049 [P] [US1] Unit test: confirming without an attribution is refused; dismissing without a
  reason is refused.
- [ ] T050 [P] [US1] Unit test: a machine with two operators in the period refuses a confirmation that
  does not name one.
- [ ] T051 [P] [US1] Unit test: `varianceAlert` and `variancePercent` are unchanged by every path in
  this phase (FR-017).
- [ ] T052 [P] [US1] Probe test with `NOSUPERUSER NOBYPASSRLS`.

## Phase 6: Consequence — the hire bill and the operator's salary (FR-003 to FR-007, FR-010)

This is where a figure first moves. It is gated on feature 016's chain, which is complete.

- [ ] T053 [US1] Add `model HireBillDeduction` in `plant` — `companyId`, `hireBillId`,
  `fuelVarianceExceptionId`, `amount`, `createdBy`, timestamps.
  `@@unique([fuelVarianceExceptionId])`, so one exception cannot be recovered twice from a bill.
- [ ] T054 [US1] **Recompute** `HireBill.netPayable` from `grossAmount`, `tdsAmount` and the sum of
  deductions. Do not decrement it in place — a vendor disputing a bill is owed the arithmetic, and a net
  reduced by an `UPDATE` cannot produce it (plan D28).
- [ ] T055 [US1] Refuse a deduction against a bill already `paid`, and carry the recovery to the next
  bill for that equipment and vendor. Adjusting a paid bill changes a figure somebody has already
  transferred against.
- [ ] T056 [P] [US1] Unit test: `netPayable` equals gross less TDS less deductions, for zero, one and
  two deductions.
- [ ] T057 [P] [US1] Unit test: a deduction against a paid bill is refused with a code naming the
  reason.
- [ ] T058 [US2] Add `model OperatorFuelRecovery` in `plant` — `companyId`,
  `fuelVarianceExceptionId`, `employeeId`, `amount`, `status`, `approvalItemId String?`,
  `appliedPayrollLineItemId String?`, `reversedAt`, `reversedByUserId`, timestamps.
  `@@unique([fuelVarianceExceptionId])`.
- [ ] T059 [US2] Raise the recovery and submit it to `ApprovalsService`. It MUST have **no path to a
  payroll line except through an approved item** (FR-006) — this is a spine gate, not a check inside the
  payroll service, and the difference is whether it can be bypassed by a second caller.
- [ ] T060 [US2] Apply on `approval.completed`, idempotently, as a **named** deduction on the payroll
  line (FR-007) — named as a fuel recovery, not as an advance. It settles through
  `SalaryAdvance`'s recovery machinery, which already handles instalments and a recovery exceeding the
  month's net, but it is not an advance: this is a recovery for loss, not money lent.
- [ ] T061 [US2] Show the recovery on the payroll line and the payslip (FR-007). A deduction an employee
  cannot see explained is a grievance waiting to happen.
- [ ] T062 [US1] [US2] Reversal (FR-010) — delete the deduction line or mark the recovery reversed,
  recording who and when. Deleting a line rather than posting an inverse adjustment is why T054
  recomputes.
- [ ] T063 [US1] Enforce FR-002's attribution as **exclusive**: an exception attributed to the hirer has
  no operator recovery and vice versa. Double recovery for one loss is the failure this prevents, and
  the `@@unique` on both tables is what makes it structural rather than a convention.
- [ ] T064 [P] [US2] e2e: raise a recovery, confirm it does **not** reach payroll while pending, approve
  it, confirm it appears as a named deduction.
- [ ] T065 [P] [US2] e2e: a rejected recovery never touches a payroll line.
- [ ] T066 [P] [US1] Unit test: an exception attributed to the hirer cannot also raise an operator
  recovery.
- [ ] T067 [P] [US1] Unit test: reversing a recovery after the underlying reading is corrected leaves the
  reversal recorded and the payroll line adjusted.

## Phase 7: The recovery cap ⚠️ RESTS ON AN UNANSWERED CLIENT QUESTION

Do not start until the client gives the cap on operator salary recovery. It is the one open
`[NEEDS CLARIFICATION]` in this spec and belongs to User Story 2.

Building phase 6 uncapped first is safe **only because FR-006 holds** — nothing reaches payroll without
approval, so an unreasonable recovery is refused by a person before it is deducted from one. That is the
specific reason this ordering is acceptable here and would not be elsewhere (plan D30).

- [ ] T068 [US2] Add the cap as a stored company setting with a config default, following D19's
  precedent for the accuracy maximum in this same feature.
- [ ] T069 [US2] Refuse a recovery above the cap at raise time, naming the cap in the refusal. Refusing
  at raise rather than at apply means the reviewer never approves something that cannot be applied.
- [ ] T070 [P] [US2] Unit test: a recovery at the cap is accepted, one above it refused.
- [ ] T071 [US2] Update the spec's Clarifications with the client's answer and the date, and remove the
  marker.

## Verification for phases 5-7

- [ ] T072 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.
- [ ] T073 Re-read `spec.md` FR-001 to FR-010 and FR-017 and confirm the built behaviour matches.
  Confirm explicitly that **detection is unchanged** — the client's item 13 asked for consequence, and
  the half that already worked must still work identically.

### Dependencies for phases 5-7

Phase 5 → 6 → 7. Phase 6 is gated on feature 016's chain (complete). Phases 5-7 are **independent of
phases 1-4**, the geofence half: the two halves of this feature share a specification and no code, so
they can be built in either order or in parallel by two people.

### MVP for this amendment

**Phase 5.** It puts every existing alert in front of a human with an attribution and a reason, which
is the whole of what is missing today, and it moves no money. Phase 6 is where recovery starts and is
the one that needs care.
