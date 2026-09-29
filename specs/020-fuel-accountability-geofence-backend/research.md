# Phase 0 Research: Per-Employee Geofence and Punch Refusal (020, User Story 3)

Scope note: this document covers User Story 3 only. Fuel accountability (US1, US2) is `bugs.md`
item 13 and is researched when that batch is worked. See plan.md, "Scope of this plan".

---

## §1 — Where the refusal belongs, given FR-013a

**Decision.** A separate `hr.PunchRefusal` table. The attendance table gains nothing — no status, no
flag, no nullable discriminator.

**Rationale.** FR-013a is the demanding requirement, not FR-013. It says a refused day must read as
*no punch at all* to every later reader — payroll, labour cost, project roll-up, the employee's own
history. Those readers exist today and they filter on what is in `PunchRecord`. Adding a `refused`
state to `PunchRecord` would make every one of those queries wrong until each learned to exclude it,
and the failure mode of the one that was missed is paying someone for a day the system refused.

Keeping refusals out of the attendance table makes the requirement structural: a reader that knows
nothing about refusals is automatically correct.

**Alternatives considered.**

- *A `status` column on `PunchRecord`.* Cheapest to write, and the reason it was rejected is above.
- *`ExceptionResolution` reuse.* The existing exception machinery is what the client replaced. Reusing
  it would recreate the reviewable item FR-013c explicitly forbids.
- *No record at all.* Genuinely considered, because "nothing is recorded" is what the client said.
  Rejected on the security reading: a stream of face-mismatch refusals against one employee is the
  signature of an impersonation attempt, and a system that keeps nothing cannot see it. FR-013c
  resolves this by separating *attendance* from *log* — nothing is recorded **as attendance**, which
  is what the client's decision was actually about.

---

## §2 — Accuracy: whether to trust the client's own number

**Decision.** Trust it, with bounds. `accuracyMeters` is validated as a non-negative number below a
sane ceiling, and a punch that omits it gets no allowance.

**Rationale.** The value comes from the device's own geolocation API and cannot be verified
server-side — a modified client could report 1 metre while standing anywhere, or report 400 metres to
widen its own fence. But the allowance only ever *widens* acceptance, so the attack it enables is
"punch from outside the fence", which is precisely the attack the fence exists to stop and which a
modified client can attempt more directly by lying about latitude and longitude outright. The accuracy
field adds no new trust; it inherits the trust the coordinates already require.

The bound exists so a nonsense value cannot produce a nonsense fence: an accuracy of 10^9 metres would
otherwise accept every punch on Earth.

**Alternatives considered.**

- *Derive accuracy server-side.* Not possible. The server sees a coordinate pair, not a fix quality.
- *Ignore accuracy entirely.* This was an option the client was offered and did not choose. It is
  today's behaviour and it refuses honest workers whose phone could not do better.
- *Cross-check against the previous punch's location.* Rejected as speculative — it would flag a
  worker who legitimately moved between sites, which is an explicitly supported case (FR-011's
  transfer scenario and the spec's "legitimately works at two sites in one day" edge case).

---

## §3 — Whether the threshold is an env var or a stored setting

**Decision.** A stored, per-company setting, with the existing config value as the fallback default.

**Rationale.** The client was asked for a number and answered with a mechanism: *"This should be
configurable from the settings by super admin."* An env var does not satisfy that — it is changeable
by whoever deploys, which is not the Super Admin and not without a release.

The default stays in configuration rather than in the service, so Principle III holds and a company
that configures nothing gets the documented 50 metres.

**Alternatives considered.**

- *Env var only* (`WORKSPACE_PUNCH_ACCURACY_MAX_METRES`). What the codebase already does for feature
  013's labour muster threshold. Rejected against the client's explicit answer.
- *Reuse 013's `WORKSPACE_LABOUR_GPS_ACCURACY_MAX_METRES` directly.* Rejected: same units, different
  surface, different tolerance. A supervisor marking a muster roll and an employee punching their own
  attendance are not the same act, and merging the two thresholds would mean tuning one to fix the
  other.
- *Per-site threshold.* Genuinely attractive — reception is a property of a place, not a company, and
  a basement slab and an open yard deserve different numbers. Rejected for **now** as scope the client
  did not ask for; recorded here because it is the obvious next request and the setting should be
  shaped so a per-site override can be added without moving the company-level one.

---

## §4 — The photo of a refused punch

**Decision.** Not retained. See plan D20 for the full argument.

**Rationale, in brief.** A face-mismatch refusal means the system could not establish whose face it
is. Retaining an unattributed biometric image indefinitely against a named employee is a worse privacy
position than the attendance record it replaces, and the employee did not consent to creating a
record they were told was refused.

**Consequence, stated plainly.** A face-mismatch refusal cannot be settled by looking at the image.
The route back is 016's manual correction on the supervisor's assertion — which is what the spec's
clarification already says the route back is.

---

## §5 — Resolving an employee's location at the time of a punch

**Decision.** A dated assignment history; resolution is the latest row with `effectiveFrom` at or
before the punch's own day.

**Rationale.** FR-011 requires every assignment change recorded with author and effective date, and
acceptance scenario 4 requires punches validated against the new location *from that date*. Both are
questions about a timeline. A current-value column answers neither, and backfilling one from an audit
log is how the two come to disagree.

Resolution keys on the **punch's day**, not the request time, because an offline-queued punch is
validated for the day it was taken. The punch path already computes `punchDay` in the business
timezone for exactly this class of reason.

**Alternatives considered.**

- *A column on `Employee` plus audit rows.* The audit log is write-only in this product and read
  through feature 004's Activity Log; making it the source of truth for a validation decision would
  make attendance depend on an audit surface. Rejected.
- *A join table with no dates, rewritten on transfer.* Loses the history FR-011 requires.

---

## Open items deliberately left to `/speckit-tasks`

- Whether phase 2's would-be-refusal logging reuses `PunchRefusal` directly or a narrower shape. It
  should reuse it — the point of phase 2 is to produce the real table's real rows — but the task list
  is where the migration ordering against phase 3 gets settled.
- Whether `PunchRefusal` rows are pruned on a schedule. They are security-relevant and small; a
  retention window is a policy question nobody has asked yet, and inventing one here would be guessing.
