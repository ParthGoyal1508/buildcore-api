# Quickstart Validation: Per-Employee Geofence and Punch Refusal (020, US3)

Each pass is runnable on its own and proves one requirement that could otherwise regress silently.
Scope is User Story 3; the fuel half has its own passes when `bugs.md` item 13 is worked.

---

## Pass 1 — a refused punch leaves nothing behind

Submit a punch outside the fence. Confirm the 422 and its code. Then — the assertion that matters —
query `hr.PunchRecord` directly and confirm **no row exists for that employee and day, in any state**.

Then read the day back through **each of the seven readers FR-013a enumerates** — payroll and its
payment sheet, the admin daily and monthly views, the employee's own history, labour and project cost
roll-ups, absence counting and leave accrual, shift-compliance reporting, and any attendance-derived
export. Each must show a day with no punch, not a refused one and not an absence-by-exception.

Seven assertions, not one. FR-013a is a requirement about readers, and testing only the writer is how
it passes while leaking — which is exactly what the requirements review found when the list was still
written as three examples (`checklists/refusal.md` CHK001).

Then assert FR-013d structurally: confirm no refusal is stored in the attendance table, so a reader
written next year inherits the guarantee without being told it exists.

Finally confirm no blob was written to storage for the refused photo (plan D20 and D17's ordering).

## Pass 2 — the accuracy allowance admits an honest worker and the maximum still refuses

Place a punch 120 m from the centre of a 100 m fence, reporting 40 m accuracy. Confirm it is
**accepted** — 120 ≤ 100 + 40.

Place the same punch reporting 400 m accuracy against a company maximum of 50. Confirm
`PUNCH_REFUSED_UNLOCATABLE`, **not** `PUNCH_REFUSED_LOCATION` — and confirm the allowance was not
applied first. That ordering is D21's specific trap: a large fence plus a huge accuracy would
otherwise admit the very fix the maximum rejects.

Then submit a punch with **no** `accuracyMeters` at all and confirm the verdict is identical to
today's raw-point verdict. Every client shipped now omits the field, and phase 1 must not move them.

## Pass 3 — the threshold is changeable by a Super Admin, without a deploy

Refuse a punch as unlocatable. Raise `punchAccuracyMaxMetres` through
`PUT /settings/company/punch-accuracy`. Retry the identical punch and confirm it is now judged against
the new value. No restart, no env change, no release.

Then confirm a caller without `COMPANY_SETTINGS` is refused the write, and that a company which has
never set it behaves exactly as the documented 50 m default.

## Pass 4 — a face mismatch refuses on the same terms as a location failure

Punch inside the fence with a face that does not match the enrolment. Confirm `PUNCH_REFUSED_FACE`, no
`PunchRecord`, and a `PunchRefusal` row with `reason: face_mismatch`.

Repeat with a photo containing no detectable face. Confirm the **same** 422 code reaches the employee
— the advice is identical, retake the photo — and a **different** `reason` in the log
(`face_undetectable`). The log distinguishes what the response does not, because the pattern worth
detecting differs and the advice does not.

## Pass 5 — the refusal log cannot become an approval queue

Enumerate every route on the refusal surface and confirm none of them resolves, approves, dismisses or
otherwise promotes a refusal into attendance. Then attempt to create a `PunchRecord` from a
`PunchRefusal` through any exposed path and confirm there is none.

This is the pass that protects FR-013c from accretion. The client rejected a reviewable exception; the
way that decision gets quietly undone is one "resolve" button added by someone who did not read the
clarification.

## Pass 6 — assignment history decides, and the fallback holds

Assign an employee to site A effective the 1st and to site B effective the 15th. Punch on the 14th
inside A's fence and confirm acceptance; punch on the 16th inside A's fence and confirm refusal.
Resolution is by the punch's **day**, so queue a punch offline on the 14th and sync it on the 16th —
it must validate against A.

Then take an employee with **no** assignment at all and confirm their punch validates against the site
fence exactly as it does today. This is FR-016, and it is the case that describes every employee in the
database on the day this ships.

Finally mark an employee mobile and confirm their punch is not refused for location, and that the
exemption names who granted it and when.

## Pass 7 — the phase-2 measurement actually measures

Before the block is switched on, run with refusal logging enabled and punches still accepted. Confirm
`PunchRefusal` rows accumulate for punches that *would* be refused while `PunchRecord` rows are still
written.

Then report the rate. This pass produces the number the client is entitled to see before phase 3
removes their ability to change their mind cheaply.

---

## What these passes cannot cover

- **Whether a hard block is the right answer.** Passes 1–6 prove it works as specified. The client was
  shown the GPS-drift consequence on 2026-09-16 and chose it; pass 7 is the closest this suite comes to
  informing that choice, and it can only do so before phase 3.
- **Whether the correction chain is enough of a recovery route.** That is feature 016's to verify, and
  phase 3 is gated on it existing. Nothing here tests it.
- **Load.** NFR-001's 150-concurrent target is unverified across this product and remains so. These
  passes say nothing about it, and the refusal path's cost under contention is untested.
- **How many honest workers get refused in practice.** Pass 2 proves the arithmetic. Only the field
  knows the distribution, which is what makes the setting in pass 3 the important part of this feature.
