# Data Model: Labour Management Backend

**Feature**: `013-labour-management-backend` | **Date**: 2026-09-01

Schemas: `labour` (9 tables), `settings` (1 new reference-data table — FR-003). Every table carries
`companyId` with RLS (FR-001), plus `createdAt`, `updatedAt`, `createdBy`, and — where soft-delete
applies (FR-036) — `deletedAt`, `deletedBy`.

**Migration note**: `hr.DailyWorker` and its attendance rows migrate into `LabourWorker` and
`MusterLine` in Phase 1, then the `hr` tables are dropped — the supersession of 005 US9 /
FR-023 to FR-028 ratified 2026-09-01.

## `settings` schema addition

### SkillCategory
`id`, `companyId`, `name` (unique per company), `code`, `defaultDailyRate?`, `isActive`.
Delete blocked while workers reference it (→ 409).

## `labour` schema

### WageRate (FR-004 to FR-007)
| Field | Type | Notes |
|---|---|---|
| id, companyId | uuid | |
| projectId | uuid | → `projects` via ProjectsService |
| skillCategoryId | uuid | → `settings` |
| dailyRate | decimal | |
| effectiveFrom | date | |
| effectiveTo | date? | null = current; auto-closed to the day before a newer rate's `effectiveFrom` |

Constraints: **non-overlapping per (projectId, skillCategoryId)**; backdating before an existing
rate's `effectiveFrom` → 400; immutable once it has priced an approved muster → 409.

### LabourWorker
| Field | Type | Notes |
|---|---|---|
| id, companyId | uuid | |
| labourCode | string | auto-generated; unique per company |
| fullName, phone, gender, dateOfBirth | | |
| aadhaarNumber? | string | **masked in lists** (FR-009); unique among active workers (FR-010) |
| bankAccount? | string | **masked in lists** (FR-009) |
| skillCategoryId | uuid | → `settings` |
| engagementType | enum | direct \| contractor |
| contractorId? | uuid | **required when contractor** (FR-008); → `partners` via PartnersService |
| siteId | uuid | → `projects` |
| rateOverride? | decimal | takes precedence over the project rate (FR-006) |
| faceEnrolmentId? | uuid | → feature 003's enrolment, reused not reimplemented (FR-011) |
| status | enum | active \| inactive |
| lastWorkingDate?, deactivationReason? | | |

### LabourGang
`id`, `companyId`, `name`, `gangLeaderWorkerId`, `siteId`, `isActive`.

### GangMember
Join table `gangId` × `workerId`. **A worker belongs to at most one active gang** (FR-012) —
enforced by a partial unique index on `workerId` where the gang is active.

### MusterRoll (FR-013, FR-016, FR-018, FR-019)
| Field | Type | Notes |
|---|---|---|
| id, companyId | uuid | |
| siteId | uuid | |
| date | date | company-timezone basis from 003 FR-018a (FR-021) |
| supervisorId | uuid | |
| latitude, longitude, accuracyMetres | | validated against the site geofence |
| geofenceViolation, lowGpsAccuracy | bool | recorded, **not rejected** (FR-013) |
| distanceFromFenceMetres? | decimal | |
| source | enum | mobile \| admin_entry |
| capturedAt, receivedAt | timestamp | both retained for offline sync (FR-018) |
| isOfflineSynced | bool | |
| status | enum | draft \| submitted \| approved |
| approvedBy?, returnReason? | | |

Constraints: **unique `(siteId, date)` among submitted/approved** — enforced in the transaction and
by a DB constraint (FR-016), applied under a row-level lock (FR-035).

### MusterLine
`id`, `companyId`, `musterId`, `workerId`, `attendanceType` (full_day|half_day|absent|
overtime_only), `overtimeHours?` (required when `overtime_only`), `photoRef` (encrypted object
storage — FR-015), `faceMatchScore?`, `faceMatchLow` (bool — **advisory, never blocking**, FR-014),
`skillCategoryIdOnDay` (snapshot, so a mid-period skill change prices correctly).

Constraints: a worker may not appear on two sites' musters for the same date (FR-017); lines become
immutable on submission (FR-020).

### LabourPaymentSheet (FR-023, FR-026 to FR-028)
`id`, `companyId`, `projectId`, `periodFrom`, `periodTo`, `engagementType`, `status`
(draft|approved|partially_disbursed|closed), `grossTotal`, `deductionTotal`, `netTotal`,
`denominationBreakup?` (jsonb — direct only), `approvedBy?`, `reopenReason?`, `closedAt?`.

Constraints: no overlapping sheet per `(projectId, engagementType, period)` → 409; figures immutable
once approved; reopen blocked once any line is disbursed.

### PaymentSheetLine
`id`, `companyId`, `sheetId`, `workerId`, `daysWorked` (full = 1, half = 0.5), `overtimeHours`,
`resolvedRate`, `rateSource` (override|project_rate — FR-006), `grossWage`, `deductions` (jsonb),
`netPayable`, `paymentMode?` (cash|bank), `paidOn?`, `paidAmount?`, `shortPaymentReason?`,
`acknowledgementRef?` (encrypted — required for cash, FR-029), `carriedForwardBalance`,
`status` (pending|disbursed|reversed).

### LabourAdvance (FR-024, FR-025)
`id`, `companyId`, `workerId`, `amount`, `reason`, `recoveryInstalments`, `instalmentAmount`
(computed), `recoveryStartPeriod`, `outstandingBalance`, `exceedsLimit` (bool), `status`
(pending|approved|disbursed|closed), `approvedBy?`, `disbursedOn?`.

Constraint: `outstandingBalance` reduced **only on disbursement of the recovering sheet line**
(FR-025), never on sheet generation.

## Computed, not stored

- **Gross wage** (FR-022): `Σ(dayFraction × applicableDailyRate) + overtimeHours ×
  (applicableDailyRate / standardHours) × companyOtMultiplier` — the multiplier read from 005
  FR-014a, never duplicated (FR-049).
- **Denomination breakup** (FR-027): minimal note count for `netTotal`, with any per-worker residual
  reported and carried forward.

## Cross-module reads (no cross-schema queries — Principle I)

| Need | Path |
|---|---|
| Site geofence, project resolution | `ProjectsService.getSitesByProject()` (FR-034) |
| Contractor resolution and status | `PartnersService` (FR-034) |
| Face enrolment and matching | feature 003's existing services (FR-011) |
| Company OT multiplier | `PayrollService` / Settings (FR-049) |

## Exported service methods

- `getLabourCostByProject(projectId, dateRange)` — consumed by 008's P&L; returns gross wage split
  by engagement type plus the count of unapproved musters excluded (FR-033).
