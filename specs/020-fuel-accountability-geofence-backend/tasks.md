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

- [ ] T001 Add `accuracyMeters?: number` to `SubmitPunchDto` in `src/hr/punch/dto/` with a
  non-negative validator and a bounded ceiling. The bound matters: an accuracy of 10^9 metres would
  otherwise accept every punch on Earth (research §2).
- [ ] T002 Extend `checkGeofence` in `src/hr/punch/geofence.util.ts` to
  `distance <= radius + (accuracyMeters ?? 0)`. **`?? 0` is the whole backward-compatibility story** —
  every client shipped today omits the field and must get exactly today's verdict. Keep the boundary
  inclusive, for the reason already written into that function.
- [ ] T003 [P] Unit test for T002: 120 m from a 100 m fence with 40 m accuracy is inside; the same
  punch with no accuracy is outside; the boundary stays inclusive.
- [ ] T004 Add `punchAccuracyMaxMetres Int?` to `settings.Company` in `prisma/schema.prisma`.
  **Nullable, not defaulted in the database**: null means "this company has not decided", which is a
  different fact from "this company chose 50", and only the first should follow a change to the
  product default.
- [ ] T005 Migration for T004. Additive, no backfill.
- [ ] T006 Add the 50-metre default to configuration in `src/common/configs/config.ts` — **not** a
  literal in a service (Principle III). Do **not** reuse feature 013's
  `WORKSPACE_LABOUR_GPS_ACCURACY_MAX_METRES`: same units, different surface, different tolerance, and
  merging them means tuning one to fix the other (research §3).
- [ ] T007 `CompaniesService.getPunchAccuracyMaxMetres(companyId)` resolving the column against the
  configured default, so no caller knows the fallback exists. Read it in `punch.service.ts` in the
  same method that already calls `getPayrollLockDay` — no new cross-module reach (Principle I).
- [ ] T008 `PUT /settings/company/punch-accuracy` under `Permission.COMPANY_SETTINGS`, which Super
  Admin holds by definition. This is the client's actual answer — *"configurable from the settings by
  super admin"* — and an env var does not satisfy it.
- [ ] T009 [P] e2e per quickstart pass 3: refuse a punch as unlocatable, raise the threshold through
  the route, retry the identical punch and confirm it is now judged against the new value, with no
  restart. Then confirm a caller without `COMPANY_SETTINGS` is refused the write.

---

## Phase 2: Log would-be refusals, still accepting (FR-013c)

This phase changes no user-visible behaviour. Its output is a number.

- [ ] T010 Add `PunchRefusal` and `enum PunchRefusalReason` to `prisma/schema.prisma` in the `hr`
  schema per data-model.md. **No photo column** — plan D20 and research §4; a face-mismatch refusal
  means the system could not establish whose face it is, and retaining an unattributed biometric
  against a named employee is worse than the record it replaces. `faceMatchDistance` is kept because a
  number is not a biometric.
- [ ] T011 Migration for T010 plus `ENABLE` + `FORCE` RLS and a `tenant_isolation` policy in
  hand-authored SQL, never in `schema.prisma`.
- [ ] T012 [P] RLS proof with the `NOSUPERUSER NOBYPASSRLS` probe role, following 016 and 017. This
  table holds location and failed-verification facts about a named person; a policy asserted rather
  than proved is not adequate here.
- [ ] T013 `PunchRefusalsService.record` in `src/hr/punch/punch-refusals.service.ts` per contracts
  Part 2.
- [ ] T014 Call it from `punch.service.ts` wherever a punch **would** be refused, while still
  recording the punch as an exception. Both happen in this phase — that is the point.
- [ ] T015 [P] e2e per quickstart pass 7: confirm `PunchRefusal` rows accumulate while `PunchRecord`
  rows are still written.
- [ ] T016 **Report the refusal rate to the client before phase 3 begins.** Not a code task. Phase 2
  exists to produce this number, and the client accepted the hard block's cost without one; delivering
  it while the decision is still reversible is the obligation this phase discharges.

---

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

## Phase 4: Per-employee assignment (FR-011, FR-014, FR-016)

Independent of phases 1–3.

- [ ] T030 Add `EmployeeLocationAssignment` to `prisma/schema.prisma` in `hr` per data-model.md, with
  the check constraint `siteId IS NOT NULL OR isMobile` — an assignment naming no site and claiming no
  exemption validates nothing, and the reader who meets it cannot tell which it was.
- [ ] T031 Migration plus RLS policy and probe-role proof.
- [ ] T032 `EmployeeLocationAssignmentsService.inForceOn(ctx, employeeId, day)` — the row with the
  greatest `effectiveFrom` at or before the punch's **day**, not the request time, so an
  offline-queued punch validates against the assignment in force when it was taken.
- [ ] T033 `assign()` appends and never mutates a prior row, recording author and effective date
  (FR-011). `isMobile` lives on the assignment, not on `Employee`, so exempting someone is itself a
  dated attributable act.
- [ ] T034 Wire resolution into `punch.service.ts`: an assignment's site fence when one exists,
  otherwise the employee's site fence exactly as today (FR-016).
- [ ] T035 [P] Unit test: no assignment falls back to the site fence. **Run it against a database
  where no assignment exists** — that is the state every employee is in on the day this ships, and the
  case that would break attendance company-wide.
- [ ] T036 Decide and record what happens when an employee has no assignment **and** their site has no
  geofence configured (`checklists/refusal.md` CHK035). FR-016 falls back to the site fence; a site
  without one is unaddressed.
- [ ] T036a [P] Unit test: a **mobile** employee is not refused for location but **is** refused for a
  face mismatch (FR-014, as clarified 2026-09-16 — finding U1). The exemption covers where someone
  works, not who they are, and the one-line implementation of "exempt from validation" is the version
  that gets this wrong.
- [ ] T037 `GET /employees/:id/location-assignments` and `PUT /employees/:id/location-assignment`
  under `Permission.EMPLOYEES`.
- [ ] T038 [P] e2e per quickstart pass 6: assignment history decides across an effective-date
  boundary, including an offline punch queued before a transfer and synced after it; a mobile employee
  is not refused for location and the exemption names who granted it.

---

## Verification

- [ ] T039 `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`.
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
