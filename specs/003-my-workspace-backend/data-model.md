# Data Model: My Workspace Backend (Punch, Leave, Salary, Face Enrolment)

Field names are conceptual; exact Prisma types are a task-level decision. See research.md §1 for
schema placement and §9 for how these entities link to feature 001/002's existing tables.

## Employee (`hr` schema — new, minimal per the confirmed scope decision)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `userId` | string | FK to `shared.User.id` (feature 001) — the account this employee record belongs to |
| `companyId` | string | FK to `settings.Company.id` (feature 002); RLS-protected |
| `siteId` | string | FK to `projects.Site.id`; the employee's currently assigned site |
| `shiftId` | string | FK to `settings.Shift.id` (feature 002); used for OT computation |
| `employeeCode` | string | Assigned via `settings`' employee-code-sequence service (feature 002) |
| `createdAt` / `updatedAt` | timestamp | |

A future HR & Payroll admin feature is expected to extend this record (department, designation,
joining date, etc.) rather than redefine it (research.md §9).

## Site (`projects` schema — new, minimal)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `companyId` | string | RLS-protected |
| `name` | string | |
| `latitude` / `longitude` | decimal | Geofence center (research.md §3) |
| `geofenceRadiusMeters` | integer | |
| `weeklyOffDay` | integer (0–6) | Day of week treated as Weekly Off |
| `holidays` | date[] (or a related `SiteHoliday` table) | Used for leave-day and attendance-status calculation |

## Face Enrolment (`hr` schema — new)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `employeeId` | string | One active row per employee (1:1) |
| `descriptor` | encrypted bytes | The derived face descriptor (research.md §2) — never the raw photos |
| `photoRefs` | string[] | Encrypted object-storage references to the 3–5 captured photos |
| `consentMethod` | enum: `signed_paper` \| `digital` \| `verbal` | |
| `consentAcknowledgedAt` | timestamp | |
| `enrolledAt` | timestamp | |
| `status` | enum: `not_enrolled` \| `enrolled` \| `re_enrolment_requested` | |

Exactly one row per employee; a completed re-enrolment (FR-016) replaces `descriptor`/`photoRefs`/
`enrolledAt` in place rather than inserting a new row — "previous template securely deleted" means
the prior encrypted values are overwritten/purged, not retained as history.

## Re-enrolment Request (`hr` schema — new)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `employeeId` | string | |
| `reason` | string | |
| `status` | enum: `pending` \| `approved` \| `rejected` \| `completed` \| `expired` | |
| `adminRemarks` | string \| null | Mandatory when `status = rejected` |
| `decidedByUserId` / `decidedAt` | string \| timestamp \| null | |
| `unlockExpiresAt` | timestamp \| null | Set on approval; 7 days out (FR-015) |
| `unlockConsumedAt` | timestamp \| null | Set when the fresh capture completes (FR-016) |

## Punch Record (`hr` schema — new)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `employeeId` | string | |
| `type` | enum: `in` \| `out` | |
| `capturedAt` | timestamp | Official punch time (client-declared; research.md §4) |
| `receivedAt` | timestamp | Server-receipt time |
| `isOfflineSync` | boolean | Derived per research.md §4 |
| `photoRef` | string | Encrypted object-storage reference |
| `faceMatchResult` | enum: `matched` \| `exception` | |
| `latitude` / `longitude` | decimal | |
| `geofenceResult` | enum: `in_range` \| `exception` | |
| `exceptionResolution` | enum: `pending` \| `confirmed` \| `rejected` \| null | Set by FR-011a's admin action when either result above is `exception` |
| `resolvedByUserId` / `resolvedAt` | string \| timestamp \| null | |

A punch-in/punch-out pair (same employee, `out.capturedAt > in.capturedAt`, no other pair between
them) forms one worked-hours computation; hours beyond `shiftId`'s duration become OT hours
(research.md §9, spec FR-009).

## Leave Type / Leave Balance (`hr` schema — new)

| Field | Type | Notes |
|---|---|---|
| `leaveType` | enum: `earned` \| `casual` \| `sick` \| `lwp` | Fixed set per the PRD |
| `employeeId` | string | |
| `financialYear` | string (e.g. `"2026-27"`) | |
| `opening` / `accrued` / `used` | decimal | |
| `balance` | decimal (computed: `opening + accrued - used`) | Not independently stored to avoid drift |

## Leave Application (`hr` schema — new)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `employeeId` | string | |
| `leaveType` | enum (as above) | |
| `fromDate` / `toDate` | date | |
| `dayCount` | decimal | Computed at submission (research.md, spec FR-019) |
| `reason` | string | |
| `status` | enum: `pending` \| `approved` \| `rejected` \| `cancelled` | |
| `adminRemarks` | string \| null | Mandatory when `status = rejected` |
| `decidedByUserId` / `decidedAt` | string \| timestamp \| null | |

## Payroll Run (`payroll` schema — new, status only)

| Field | Type | Notes |
|---|---|---|
| `companyId` | string | |
| `period` | string (e.g. `"2026-07"`) | |
| `status` | enum: `draft` \| `processed` \| `paid` | This feature only reads this field |

## Salary Slip (`payroll` schema — read projection; figures assumed pre-computed elsewhere)

| Field | Type | Notes |
|---|---|---|
| `employeeId` | string | |
| `period` | string | Must reference a `processed`/`paid` PayrollRun |
| `monthDays` / `payableDays` / `lopDays` / `otHours` | number | |
| `earnings` | `{ basic, hra, conveyance, siteAllowance, specialAllowance, ot }` | |
| `deductions` | `{ pf, esic, pt, tds, loanEmi, advanceRecovery }` | |
| `employerContributions` | `{ pf, eps, edli, adminCharges, gratuity, bonus }` | Informational only |
| `netPay` | number | |
| `netPayInWords` | string | |
| `minimumWagesNote` | string | |

This feature formats and serves this projection (JSON + PDF, research.md §7); it does not compute
the underlying payroll figures.

## Reimbursement Claim (`hr` schema — new)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `employeeId` | string | Owner; every access scoped to this (FR-033) |
| `companyId` | string | RLS-protected |
| `categoryId` | string | FK `settings.ReimbursementCategory` (feature 005) |
| `amount` | decimal | |
| `expenseDate` | date | |
| `description` | string | |
| `receiptRef` | string \| null | Encrypted object-storage reference; required above the category's threshold (FR-030) |
| `status` | enum | `draft` \| `submitted` \| `approved` \| `rejected` \| `paid` |
| `paymentMode` | enum \| null | `payroll` \| `direct`, set once approved+paid (feature 005) |
| `paymentReference` | string \| null | Set on direct payment (feature 005) |

Created/edited/withdrawn by this feature (FR-029–FR-032); `approved`/`rejected`/`paid` transitions
and `paymentMode`/`paymentReference` are written by feature 005's admin layer over the same table
(research.md §10) — this feature only reads those fields, never writes them.

## Cross-reference to feature 001/002

| Concept | Relationship |
|---|---|
| `Employee.userId` | FK to `shared.User.id` (feature 001) |
| `Employee.companyId`, `Site.companyId` | FK to `settings.Company.id` (feature 002) |
| `Employee.shiftId` | FK to `settings.Shift.id` (feature 002) — OT computation reads shift duration via `SettingsModule`'s exported service, never a direct cross-schema join |
| `ReimbursementClaim.categoryId` | FK to `settings.ReimbursementCategory.id` (feature 005 adds this table to `settings`) — read via `SettingsService.getReimbursementCategories()`, never a direct cross-schema join (research.md §10) |
| `AuditLogEntry` (`shared` schema) | Reused, not redefined — every event this feature logs (FR-027) goes through the same `AuditLogService.record()` feature 001/002 establish, with `entityType` values `PUNCH`, `LEAVE_APPLICATION`, `FACE_ENROLMENT`, `RE_ENROLMENT_REQUEST`, `REIMBURSEMENT_CLAIM` added to that enum |
