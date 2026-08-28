# Research: HR & Payroll Backend (Employees, Attendance, Leave, Payroll, Challans, Loans, Daily Workers)

## 1. Schema placement

**Decision**: `hr` schema (already established by feature 003) gains the bulk of this feature:
extended `Employee` columns, `EmployeeDocument`, `EmployeeTransfer`, `AttendanceModification`,
`Holiday`, `DailyWorker`, `DailyWorkerAttendance`. `payroll` schema (stub from 003) gains the real
`PayrollRun` extension, `PayrollLineItem`, `Loan`, `LoanScheduleEntry`. `Challan` data is computed,
not stored (research.md §7). No new schema is introduced.

**Rationale**: Matches the constitution's named module list exactly; this feature is squarely "hr"
and "payroll" work, unlike Dashboard's cross-cutting `shared` placement.

**Alternatives considered**: A dedicated `loans` or `daily-workers` schema — rejected: neither is
named in the constitution's module list, and both are clearly sub-concerns of `hr`/`payroll`
rather than independent business modules with their own extraction boundary.

## 2. Extending `Employee` without breaking feature 003

**Decision**: All ~40 additional fields (Identity/Employment/Statutory/Pay & Bank/Contact tabs,
Letters toggles, Onboarding checklist) are added as new, mostly-nullable columns on the existing
`hr.Employee` table via a single additive migration — `userId`, `companyId`, `siteId`, `shiftId`,
`employeeCode` (003) are untouched. PII fields (Aadhaar, PAN, bank account number, UAN) are added as
encrypted columns with a paired `*Masked` computed/service-layer value (last 4 digits) that's what
every response returns by default.

**Rationale**: An additive migration is the lowest-risk way to extend a table another already-
specced feature depends on; splitting Employee across two tables (e.g., a new `EmployeeProfile`
joined 1:1) would force every existing 003 read (self-service punch, leave, salary) to start
joining across two tables for no benefit.

**Alternatives considered**: A separate `EmployeeProfile` 1:1 extension table — rejected per above;
also would need its own RLS policy duplicating `Employee`'s, for zero isolation benefit since
they'd always be read together.

## 3. PII masking and reveal

**Decision**: A `PiiMaskingInterceptor` (NestJS response interceptor) truncates Aadhaar/PAN/bank-
account/UAN fields to their last 4 digits on every response by default; a dedicated
`POST /hr/employees/:id/reveal-pii` endpoint (permission-gated, itself audit-logged with which
field was revealed and by whom) returns the unmasked value for one field on demand, per Constitution
Principle IV's existing requirement ("masked by default... unmasked reveal MUST require an explicit
role-gated action... every unmasked read... written to the audit log").

**Rationale**: This is the first feature with fields matching the constitution's own named
regulated-PII list (Aadhaar/PAN/bank details) — implementing the masking/reveal/audit mechanism
Principle IV already mandates, not inventing new policy.

**Alternatives considered**: Mask at the database view layer instead of an interceptor — rejected:
Prisma doesn't have a clean per-field "except when explicitly revealed" view mechanism; an
interceptor keeps the masking logic in one reusable place across every endpoint returning Employee
data.

## 4. Payroll calculation engine

**Decision**: A `PayrollEngineService.generate(companyId, period)` runs inside a single Prisma
transaction: for every active Employee, it reads that period's attendance (via `hr`'s own
attendance-computation logic, extended from 003's per-day status), the employee's salary structure
fields, active `Loan`s' current-cycle EMI, and the company's configured rates (PF/ESIC/Gratuity/
Bonus from Settings 002, OT multiplier from FR-014a) to compute one `PayrollLineItem` per employee,
persisting the whole run as `PayrollRun.status = 'draft'`. Marking a run `processed` is a separate,
explicit action (not automatic) that flips an immutability flag checked by every write path
touching that period's attendance/leave/line-items (extending 003's existing payroll-lock check,
research.md there §9's "assumes... already done").

**Rationale**: A single transaction per generation run avoids a partially-computed run being
visible mid-generation; reusing 003's attendance-computation function (rather than a second,
parallel implementation) keeps "what counts as Present/Absent/OT" defined in exactly one place.

**Alternatives considered**: Compute payroll figures lazily on read (no stored `PayrollLineItem`,
recompute every time a slip is viewed) — rejected: violates FR-015's immutability requirement
outright (a lazy recompute after later attendance edits would silently change a "Processed" run's
figures) and is also the exact bug class Constitution Principle I's HLD rationale calls out for
payroll ("double-submit correctness gap").

## 5. Challans as a derived view, not a stored table

**Decision**: `GET /hr/challans/:type` (pf/esic/pt) reads a Processed/Paid `PayrollRun`'s
`PayrollLineItem` rows and reshapes them into the challan's specific column set and summary totals
at request time — no `Challan` table exists.

**Rationale**: FR-019 requires challan figures to trace exactly to the source payroll run with zero
independent recomputation; a derived read is definitionally unable to drift from its source, while
a stored, separately-maintained `Challan` table could.

**Alternatives considered**: Persist a `Challan` snapshot at the moment payroll is Processed —
rejected: adds a second copy of the same numbers with its own staleness-management burden, for a
benefit (faster reads) not justified by this feature's data volumes (a challan read is one join
over a single month's line items, not a heavy aggregation).

## 6. Holiday: superseding `Site.holidays`

**Decision**: A new `Holiday` table (`hr` schema: name, date, type, applicability — either "all
sites" or a join to specific `Site` rows) replaces 003's flat `Site.holidays: date[]` field.
Attendance-status computation (003 research.md §6) is updated to query `Holiday` instead of reading
the array column, which this feature's migration drops.

**Rationale**: The PRD names Holiday as a first-class entity (name, type, per-site applicability) —
the flat array 003 used as a placeholder (before this feature existed to build the real thing) can't
represent any of that.

**Alternatives considered**: Keep `Site.holidays` alongside the new `Holiday` table, syncing between
them — rejected: two sources of truth for the same concept with no reason to keep both once this
feature ships.

## 7. Attendance admin edit + Modifications audit

**Decision**: The admin Mark/Edit action writes to the same `hr.PunchRecord`-derived attendance
representation 003 established (extending it with an `adminEdited: boolean` and
`editedByUserId`/`editedAt` pair), and every such edit additionally inserts one
`AttendanceModification` row (employee, date, actor, before-JSON, after-JSON, timestamp) — an
append-only audit trail distinct from the general `AuditLogEntry` (which logs "an edit happened,"
while `AttendanceModification` carries the specific before/after values the PRD's own Modifications
Modal needs to render a diff).

**Rationale**: `AuditLogEntry`'s shape (entityType/action/entityId/changes JSON, per feature 002's
generalization) *could* carry this, but the PRD's Modifications Modal is a dedicated,
attendance-specific view with its own column set (Employee, Date, Changed By, Changed From → To,
Timestamp) — a dedicated table keeps that query simple and fast without over-loading the generic
audit log's `changes` JSON blob as a queryable structured field.

**Alternatives considered**: Query `AuditLogEntry.changes` (JSON) for attendance-specific edits at
read time — rejected: JSON-field querying/filtering for a dedicated, frequently-viewed admin table
is worse ergonomics and performance than a purpose-built table with real columns.

## 8. Daily Worker Registry: parallel to Employee, reusing biometrics

**Decision**: `DailyWorker` and `DailyWorkerAttendance` are new `hr`-schema tables, structurally
independent of `Employee`/`FaceEnrolment`/`PunchRecord` (no shared foreign keys, no shared rows) —
but `DailyWorker` enrolment calls the exact same `BiometricsService.computeDescriptor()` (003)
Employee enrolment uses, and `DailyWorkerAttendance` marking calls the same
`BiometricsService.compareDescriptors()` for face-match. Site-headcount aggregation (consumed by
Dashboard, 004) reads both `PunchRecord` (Employee) and `DailyWorkerAttendance` and sums them,
tagged separately.

**Rationale**: The PRD is explicit that Daily Workers are a deliberately lighter-weight, separate
system ("tracked separately... distinct 'Daily Worker' tag... do not enter the statutory PF/ESIC/
payroll-slip pipeline") — sharing the Employee table would require nullable-everything columns and
constant "is this a real employee or a daily worker" branching throughout every other feature that
touches Employee. Reusing `BiometricsService` (rather than a second face-matching implementation)
avoids duplicating the one already-approved architectural dependency.

**Alternatives considered**: Model `DailyWorker` as a special `Employee` row (e.g. `type:
'daily_worker_lite'`) — rejected: exactly the "nullable everything, branch everywhere" problem
above; every existing 003 Employee-scoped query (punch, leave, salary) would need to filter these
out, a correctness risk for no benefit over a genuinely separate table.

## 9. Daily-Worker-to-Employee conversion

**Decision**: A `POST /hr/daily-workers/:id/convert` action creates a new `Employee` +
`FaceEnrolment` row, copying the `DailyWorker`'s photos/descriptor into the new `FaceEnrolment`
(no re-capture required, per spec Edge Cases), and sets `DailyWorker.status = 'converted'` (a new
enum value alongside active/inactive) with a reference to the resulting `Employee.id` — the
original `DailyWorker`/`DailyWorkerAttendance` rows are retained, never deleted, preserving their
historical attendance's referential integrity.

**Rationale**: Directly implements the spec's Edge Case; retaining rather than deleting/merging
avoids a data-migration hazard (rewriting foreign keys on potentially many historical
`DailyWorkerAttendance` rows) for a benefit (a single unified history) the PRD doesn't ask for.

**Alternatives considered**: Migrate `DailyWorkerAttendance` rows to point at the new `Employee`
instead — rejected: those rows represent a real historical fact (this person was tracked as a
daily worker on these dates) that shouldn't be rewritten just because their status later changed.

## 10. Document storage and deferred virus scanning

**Decision**: `EmployeeDocument.fileRef` is an encrypted object-storage reference (same pattern as
003's biometric `photoRefs`), with `expiresAt`/`documentNumber` metadata columns. A
`TODO(VIRUS_SCAN)` is recorded in this feature's own code (a `// TODO` at the upload handler, plus
a note in this repo's constitution's Deferred/TODO list) rather than silently omitted, per the
clarification's "tracked as a known gap, not silently omitted" requirement.

**Rationale**: Reuses an established storage pattern; explicitly tracking the deferred scanning
step (rather than just not mentioning it) keeps the gap visible for whoever picks up that
infrastructure work later.

**Alternatives considered**: None seriously — this follows directly from the clarification.

## 11. Reconciling with features 001–004

**Decision**: This feature's Permission checks reuse Settings' (002) already-defined enum values
verbatim — `EMPLOYEES`, `ATTENDANCE`, `PAYROLL`, `CHALLANS`, `LOANS`, `DAILY_WORKER_REGISTRY` — no
new permission values needed (unlike Dashboard's gap, which had to reuse `DASHBOARD` broadly; this
feature's PRD areas map 1:1 onto already-existing, specific permission values).

**Rationale**: Feature 002's `Permission` enum was deliberately built covering every PRD module by
name (research.md §4 there) — this is exactly the payoff of that earlier design decision.

**Alternatives considered**: None needed — the mapping is direct.

## 12. Offboarding & F&F: reusing the payroll engine, not a parallel calculator

**Decision**: `ExitRecord` is a new `hr` table. F&F computation (`fnf.service.ts`) computes pending
salary/EL-encashment/loan-recovery as inputs, then hands off to US5's existing payroll engine to
produce an F&F-flagged `PayrollRun` — never a second, parallel payroll-calculation path. EL
encashment rate is `employee.basic / 26` per day; loan recovery is the full outstanding balance
(not a partial write-off) unless separately waived — both fixed computation rules, not
company-configurable settings, matching spec's own Assumptions text.

**Rationale**: A second payroll calculator for F&F would duplicate US5's already-audited PF/ESIC/
PT/TDS logic for exactly the values that most need to be correct (a departing employee's final
pay) — reuse is both less code and lower-risk.

**Alternatives considered**: A standalone F&F calculator independent of the payroll engine —
rejected for the duplication/correctness-risk reason above.

## 13. Reimbursements Admin: extends 003's table, no second one

**Decision**: This feature's admin layer (list/approve/reject/pay/register) operates directly on
feature 003's `hr.ReimbursementClaim` table (003 research.md §10) — this feature does not create
its own reimbursement table. `ReimbursementCategory` is a new table this feature adds to
`settings` (spec Assumptions), consumed by 003 via `SettingsService.getReimbursementCategories()`.

**Rationale**: Exactly the same shape as this feature's existing Leave admin story (US4) reusing
003's `LeaveApplication` table — one entity, one owning schema (`hr`, since the employee
self-originates it), a thin admin layer added wherever the review workflow needs it.

**Alternatives considered**: A separate `payroll.ReimbursementClaim` admin-side table, synced from
003's — rejected: introduces a sync-consistency problem (which one is authoritative?) for no
benefit over directly extending the one table with admin-only fields (`status` transitions beyond
`submitted`, `paymentMode`, `paymentReference`).

## 14. Bulk Attendance Import: reuses US3's write path, doesn't duplicate it

**Decision**: `attendance-import.service.ts`'s `commit()` step calls US3's existing
`attendance-admin.service.ts` record-creation function row-by-row (after validation), rather than
writing `AttendanceRecord` rows directly — so Total-Hours computation, status derivation, and the
payroll-lock rejection rule (FR-009) all come from the single existing implementation, never a
second copy that could drift.

**Rationale**: The PRD's own validation-report-before-commit shape (mirroring BOQ Import and
Employee Master bulk import elsewhere in the master PRD) is a batching/UX concern layered on top
of attendance creation — the underlying record-creation rules shouldn't differ based on which UI
path produced the record.

**Alternatives considered**: A separate bulk-insert path bypassing per-row validation for
performance — rejected: attendance data feeds payroll; a bypassed lock-check or status-computation
bug here is a correctness risk the PRD's own emphasis on payroll accuracy weighs against, and
typical import batch sizes (per site, per pay period) don't need bulk-insert-level throughput.

## 15. Reimbursement Categories CRUD — a second gap found on re-audit

**Decision**: `/settings/reimbursement-categories` gets the exact same CRUD shape as 002's
existing Department/Designation/Document Type/Shift masters (research.md — 002's own §-numbered
decision for that pattern), guarded with the same `EMPLOYEES` permission, living in
`src/settings/reimbursement-categories/` (`settings` schema).

**Rationale**: This was missed in the first alignment-audit pass — §13's decision (Reimbursements
Admin) only addressed the *claim* review workflow and assumed the category master's CRUD existed
somewhere, but nothing in this feature (or any other) ever built it; category creation was
implicitly assumed to be seed-only, which the master PRD does not support (§7.8.4 lists it as an
admin-editable master, matching every sibling in that table). Caught on a second pass specifically
re-checking Reimbursement coverage end-to-end.

**Alternatives considered**: None — this is a straightforward gap-fill matching an already
-established pattern, not a design decision.

## 16. `getLabourCostByProject()` — a cross-module contract 008 needed that didn't exist

**Decision**: Add a nullable `projectId` column to `PayrollLineItem` (FR-046) and an exported
`HrPayrollService.getLabourCostByProject(projectId, dateRange)` summing `netPay` across matching
line items. `projectId` is set at payroll-run generation time from the employee's current site/
project assignment (existing `Employee` data); it is not retroactively backfillable for historical
runs predating this field, which simply return null/unattributed for those periods.

**Rationale**: `008-projects-backend`'s Project P&L (research.md §10 there) assumed this method and
field already existed on this feature and defined a stub-fallback contract for the case they
didn't ship yet — but the assumption itself was wrong: this feature never attributed payroll line
items to a project at all. Found during 008's master-PRD alignment audit sweep; fixed here rather
than left as a permanent P&L zero-value fallback, since Labour is the single largest cost line in
a construction project P&L and a permanently-stubbed value would defeat the P&L's purpose.

**Alternatives considered**: Deriving labour cost from `Employee.projectId` × days-in-period
instead of a stored per-line-item `projectId` — rejected: an employee can be reassigned mid-period,
and `PayrollLineItem` is already the period-scoped source of truth every other consumer
(`/hr/challans/*`, `/my/salary`) reads from; adding the field there keeps one source of truth
rather than two divergent computations of the same cost.

## 17. `getUnlinkedEmployees()`/`linkEmployeeToUser()` — needed by the new Account Creation feature

**Decision**: Add two exported `HrService` methods: `getUnlinkedEmployees(companyId, search?)` —
lists `Employee` rows with no `userId` set, for the Account Creation feature's employee-picker
dropdown — and `linkEmployeeToUser(employeeId, userId)` — sets `Employee.userId`, throwing if
already set. No new fields; `Employee.userId` has existed since 003.

**Rationale**: `010-account-creation-backend` (the feature that finally implements master PRD
§7.1's Invite Flow, closing a gap 001 and 002 both explicitly deferred to "a separate Account
Creation feature" that was never built) is the first feature to ever need to query "which
employees have no login yet" or write `Employee.userId` — no prior feature had a reason to. This
mirrors §16's pattern exactly: a downstream feature assumed a capability existed here, it didn't,
so it's added here as a small amendment rather than worked around.

**Alternatives considered**: Having Account Creation query `hr.Employee` directly since it's a
small, simple filter — rejected: still a cross-schema query from `account-creation`'s eventual
module into `hr`'s schema, which Constitution Principle I forbids regardless of query complexity;
the exported-method boundary exists precisely to avoid this kind of "just this once" exception.
