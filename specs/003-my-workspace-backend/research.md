# Research: My Workspace Backend (Punch, Leave, Salary, Face Enrolment)

## 1. Schema-per-module placement

**Decision**: `hr` schema owns Employee, Site-assignment link, PunchRecord, LeaveType/LeaveBalance/
LeaveApplication, FaceEnrolment, and ReEnrolmentRequest. `projects` schema owns Site (geofence +
holiday calendar) — construction sites are inherently a projects-module concept per the module
list, not an HR one. `payroll` schema owns PayrollRun (status only) and the SalarySlip read
projection. Cross-schema reads (e.g. `hr` needing a Site's geofence, or needing `settings.Company`'s
payroll-lock-day) go through each owning module's exported service method (Principle I), never a
direct cross-schema query.

**Rationale**: Matches the constitution's named module list exactly; Site clearly belongs with
Projects (where a future Projects feature will own the rest of a site's data), not HR, even though
this feature is the first to need any part of it.

**Alternatives considered**: Put Site in `hr` since this feature is the only current consumer —
rejected: would misplace a concept the constitution already names a home for, creating exactly the
kind of un-split skeleton Principle I's Development Workflow section says new module work must
avoid.

## 2. Face matching: `@vladmandic/face-api`, in-process

**Decision**: A `BiometricsService` in `hr` uses `@vladmandic/face-api` (now pre-approved,
constitution v1.1.0) to compute a 128-dimension face descriptor from each enrolment/punch photo and
compare via Euclidean distance against the employee's stored descriptor (not the raw photos) — a
match is anything below a configured distance threshold (`FaceMatchConfig.threshold`, centralized
per Principle III, not a magic number inline).

**Rationale**: Per the user's explicit clarification decision; storing only the derived descriptor
(not doing a live photo-to-photo comparison every time) keeps the hot path (punch verification) to
one vector-distance calculation instead of repeated model inference against multiple stored photos.

**Alternatives considered**: Store all enrolled photos and re-run matching against each at punch
time — rejected: `@vladmandic/face-api`'s own recommended pattern is descriptor comparison, and
redoing inference against up to 5 photos per punch would be strictly slower for no accuracy gain
over comparing against one averaged/best descriptor.

## 3. Geofence validation

**Decision**: Server-side Haversine-distance calculation between the punch's submitted GPS
coordinates and the employee's assigned Site's stored center coordinates, compared against that
Site's configured radius (meters). A punch is in-geofence when distance ≤ radius.

**Rationale**: Standard, dependency-free great-circle distance formula appropriate for
site-radius-scale distances (meters to a few km) — no mapping/geospatial library needed for a
single point-radius check.

**Alternatives considered**: PostGIS geospatial types/functions — rejected as unnecessary
complexity: this feature needs exactly one distance-to-a-point check per punch, not general
geospatial querying; introducing PostGIS would also be a new architectural dependency requiring its
own amendment for a capability a plain formula already covers.

## 4. Offline-sync timestamp handling

**Decision**: `PunchRecord` stores both `capturedAt` (client-declared, becomes the official punch
time per the clarification) and `receivedAt` (server timestamp), with `isOfflineSync = capturedAt <
receivedAt - <clock-skew-tolerance>`. A configured `maxOfflineQueueAgeHours` (centralized config)
rejects a `capturedAt` older than that window.

**Rationale**: Directly implements the clarification; the clock-skew tolerance avoids flagging
every normal punch as "offline" due to trivial client/server clock drift.

**Alternatives considered**: Only store `capturedAt`, discard `receivedAt` — rejected: FR-012
explicitly requires both retained for audit visibility into offline-synced punches.

## 5. One-open-punch-in-at-a-time enforcement

**Decision**: A unique partial index / application-level check ensuring at most one `PunchRecord`
per employee has `type = 'IN'` with no matching `type = 'OUT'` record at any time — enforced inside
the same transaction that creates a new punch-in, using `SELECT ... FOR UPDATE` on the employee's
latest open record to avoid a race between two concurrent punch-in requests.

**Rationale**: Matches FR-008/Edge Cases (double-submit protection); a transactional row lock is
the standard, dependency-free way to prevent the exact race a naive check-then-insert would allow.

**Alternatives considered**: A database trigger — rejected: keeps the same logic split across
Prisma-managed migrations and hand-written SQL, inconsistent with Principle VI's "generated
migrations, never hand-edited SQL."

## 6. Attendance-status computation

**Decision**: An employee's per-day attendance status (Present/Absent/On Leave/Weekly Off/Holiday)
is computed on read (not stored as its own column) from: matched punch pairs → Present; an
Approved `LeaveApplication` covering that date → On Leave; the Site's holiday calendar → Holiday;
the employee's weekly-off day-of-week → Weekly Off; otherwise, if none apply and no punch exists →
Absent.

**Rationale**: Avoids a second source of truth that could drift from the underlying punch/leave/
site data (e.g., an approval landing after the "status" was last written); this data volume (one
employee-month at a time) makes on-read computation cheap enough not to need caching yet.

**Alternatives considered**: A materialized/stored daily-status table updated on every punch/leave
change — rejected as premature: no performance requirement in the spec justifies the added
write-side complexity and staleness-management this would introduce.

## 7. PDF generation: `pdfkit`

**Decision**: `SalarySlipService` builds the same figures used for the structured JSON response into
a `pdfkit` document with a fixed, programmatic layout (header, attendance summary, earnings/
deductions tables, net pay, minimum-wages note) — no HTML/CSS templating layer.

**Rationale**: Per the user's explicit choice (constitution v1.1.0); a payslip is a fixed, largely
tabular layout well-suited to `pdfkit`'s programmatic drawing API without needing a headless-browser
dependency's weight.

**Alternatives considered**: Puppeteer/HTML-to-PDF — explicitly not chosen (user's decision);
recorded here only for completeness.

## 8. Biometric data protection tier

**Decision**: Biometric photos and derived descriptors are stored in encrypted-at-rest columns/
object storage, every read is written to the audit log (reusing the shared `AuditLogService`
pattern feature 001/002 establish), and consent withdrawal triggers deletion via a scheduled/
immediate job rather than a soft-delete flag — matching the same protection tier Principle IV
mandates for Aadhaar/PAN/bank fields, per FR-026's explicit extension of that tier to biometric
data.

**Rationale**: FR-026 already settles this as a spec-level requirement; this is the implementation
mechanism, reusing infrastructure other features already establish rather than inventing a second
audit/encryption pattern.

**Alternatives considered**: Soft-delete (flag + eventual cleanup job) for consent-withdrawal
deletion — rejected: FR-004/FR-026 require deletion "within the configured retention-policy
window," and a soft-delete flag alone doesn't satisfy "permanently delete" without a concrete,
verifiable hard-delete step.

## 9. Reconciling with existing specs

**Decision**: `Employee.roleId`/`Employee.userId` link to `shared.User` (feature 001) and
`Employee.companyId` to `settings.Company` (feature 002); `Employee.shiftId` links to
`settings.Shift` (feature 002) for OT computation (spec FR-009). No fields are duplicated from
those tables — this feature reads them via each owning module's exported service, consistent with
research.md §1.

**Rationale**: Both prior features already exist as specs in this repo; reusing their entities
(rather than re-defining a second `Shift` or `Company` inside `hr`) is exactly what Principle I's
schema boundaries are for.

**Alternatives considered**: Duplicate a denormalized `shiftDuration` field onto `Employee` —
rejected: introduces a second source of truth for data `settings.Shift` already owns, with no
performance justification in this feature's requirements.
