# Implementation Plan: My Workspace Backend (Punch, Leave, Salary, Face Enrolment)

**Branch**: `003-my-workspace-backend` | **Date**: 2026-08-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-my-workspace-backend/spec.md`

## Summary

Build the self-service `hr`/`projects`/`payroll` schema entities (Employee, Site, PunchRecord,
FaceEnrolment, ReEnrolmentRequest, LeaveType/Balance/Application, PayrollRun status, SalarySlip
projection) and their `/my/*` endpoints, plus the admin-side attendance-exception-resolution and
leave-approval endpoints this feature also owns per its clarification. In-process face matching
(`@vladmandic/face-api`) and PDF generation (`pdfkit`) are both newly pre-approved additions to
this repo's constitution (v1.1.0), introduced by this feature at the user's explicit direction. See
[research.md](research.md) for the full set of technical decisions, especially schema placement
(§1) and how this feature reconciles with feature 001 (`shared.User`) and feature 002
(`settings.Company`/`settings.Shift`) rather than redefining them (§9).

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — unchanged
from features 001/002.

**Primary Dependencies**: Existing — `class-validator`/`class-transformer`, `@nestjs/swagger`,
`@nestjs/config`, `nestjs-prisma`, feature 001's `JwtAuthGuard`/`RolesGuard`, feature 002's
permission-guard extension. New — `@vladmandic/face-api` (in-process face matching, research.md
§2) and `pdfkit` (salary-slip PDF, research.md §7), both newly pre-approved (constitution v1.1.0).

**Storage**: PostgreSQL via Prisma multi-schema — adds `hr` and `projects` schemas (new) and
extends the existing `payroll`-schema stub with `PayrollRun`/`SalarySlip`; extends `shared`'s
`AuditLogEntry.entityType` enum (data-model.md cross-reference).

**Testing**: Jest unit tests for every new service (geofence distance calc, offline-timestamp
tagging, leave day-count calc, face-match threshold logic, one-open-punch-in guard) and
`test/my-workspace.e2e-spec.ts` — this repo's constitution requires e2e coverage for endpoints
touching PII, and biometric/attendance/payroll data all qualify.

**Target Platform**: Linux server (Node.js), same as the rest of `buildcore-api`.

**Project Type**: Web service (backend API) — single NestJS project; adds `hr`/`projects` modules
and extends `payroll`'s stub module.

**Performance Goals**: A punch-in/out round trip (photo + GPS submission → recorded response)
completes in a normal-conditions timeframe consistent with SC-001's 10-second end-to-end UX target;
the face-match computation itself (one descriptor comparison per punch) is the dominant cost and
must stay well within that budget.

**Constraints**: Every controller method uses a validated DTO (Principle II); `hr`/`projects`/
`payroll` modules never query directly into `shared`/`settings` schemas — cross-module reads go
through each owning module's exported service (Principle I, research.md §1/§9); biometric photos/
descriptors encrypted at rest with every access audit-logged (Principle IV, FR-026, research.md
§8); face-match threshold, offline-queue max age, and re-enrolment unlock duration all centralized
config, never inline magic numbers (Principle III); every Prisma schema change ships as a generated
migration (Principle VI).

**Scale/Scope**: Three new schemas' worth of entities (~10, including the new Reimbursement Claim
added for US8), ~24 employee-facing endpoints plus 4 admin-side endpoints
(contracts/my-workspace-api.md), two newly pre-approved dependencies. No existing feature 001/002
code is modified beyond the additive schema changes in data-model.md's cross-reference table
(`User.roleId` unaffected; `AuditLogEntry.entityType` gains new values; `settings` gains a
`ReimbursementCategory` table, added by feature 005, read here read-only).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries (NON-NEGOTIABLE) | New `hr`/`projects` schemas match the named module list; `payroll` schema extended, not newly created. All cross-schema needs (Employee↔User, Employee↔Company/Shift, AuditLogEntry writes) go through each owning module's exported service (research.md §1, §9). | PASS |
| II. Validated DTO Contracts (NON-NEGOTIABLE) | Every endpoint in contracts/my-workspace-api.md uses a typed DTO; global `ValidationPipe` continues to reject unexpected fields. | PASS |
| III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE) | Face-match distance threshold, max offline-queue age, re-enrolment unlock duration (7 days), and clock-skew tolerance all added to a typed `WorkspaceConfig` (`config.ts`/`config.interface.ts`), not inline. | PASS |
| IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE) | Every `companyId`-scoped table RLS-protected per the existing pattern; biometric data explicitly extended to the same encryption/audit/masking tier as named regulated PII, per FR-026 (research.md §8) — this is a spec-level requirement this plan implements, not a new constitutional obligation being invented. | PASS |
| V. Authentication, Authorization & Secrets Hygiene | Every `/my/*` endpoint behind `JwtAuthGuard`; admin-side endpoints additionally behind `@RequirePermission()` (feature 002's guard). No new auth mechanism introduced. | PASS |
| VI. Observability & Safe Migrations | All new schema changes (three schemas' worth) ship as generated Prisma migrations. | PASS |

**New architectural dependencies**: `@vladmandic/face-api` and `pdfkit` are both now pre-approved
in the constitution (v1.1.0, amended as part of this feature's planning, at the user's explicit
direction in both cases) — no Complexity Tracking entry required; this is the intended "module that
needs them lands" trigger the constitution's Technology Stack section describes for its
pre-approved-package pattern.

**Post-design re-check (after Phase 1)**: data-model.md and contracts/my-workspace-api.md keep
every module's queries inside its own schema, every biometric field on the protected-tier path, and
every new config value centralized. Still PASS.

## Project Structure

### Documentation (this feature)

```text
specs/003-my-workspace-backend/
├── plan.md                    # This file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
└── contracts/
    └── my-workspace-api.md    # Phase 1 output

(tasks.md — Phase 2 output, /speckit-tasks — not created by /speckit-plan)
```

### Source Code (repository root)

```text
buildcore-api/
├── prisma/
│   ├── schema.prisma                             # MODIFIED — new `hr` schema (Employee,
│   │                                             #   PunchRecord, FaceEnrolment,
│   │                                             #   ReEnrolmentRequest, LeaveType/Balance/
│   │                                             #   Application), new `projects` schema (Site),
│   │                                             #   `payroll` schema gets PayrollRun/SalarySlip;
│   │                                             #   `shared.AuditLogEntry.entityType` extended
│   └── migrations/                                # NEW migration(s) via `migrate:dev:create`
├── src/
│   ├── common/configs/
│   │   ├── config.ts                              # MODIFIED — WorkspaceConfig (thresholds,
│   │   │                                         #   max offline age, unlock duration)
│   │   └── config.interface.ts                    # MODIFIED — WorkspaceConfig type
│   ├── hr/
│   │   ├── hr.module.ts                           # NEW
│   │   ├── employees/employees.service.ts         # NEW — exported for other modules to resolve
│   │   │                                         #   `userId → Employee`
│   │   ├── biometrics/
│   │   │   ├── biometrics.service.ts              # NEW — face-api.js descriptor compute/compare
│   │   │   ├── face-enrolment.controller.ts       # NEW — /my/face-enrol*
│   │   │   ├── face-enrolment.service.ts          # NEW
│   │   │   └── dto/                               # NEW — enrol/re-enrolment DTOs
│   │   ├── punch/
│   │   │   ├── punch.controller.ts                # NEW — /my/punch*
│   │   │   ├── punch.service.ts                   # NEW — geofence calc, offline tagging,
│   │   │   │                                     #   open-punch-in guard (research.md §5)
│   │   │   └── dto/
│   │   ├── attendance-exceptions/
│   │   │   └── attendance-exceptions.controller.ts # NEW — /workspace-admin/attendance-exceptions*
│   │   └── leave/
│   │       ├── leave.controller.ts                 # NEW — /my/leave*
│   │       ├── leave-admin.controller.ts           # NEW — /workspace-admin/leave-applications*
│   │       ├── leave.service.ts                    # NEW — day-count calc, balance check
│   │       └── dto/
│   │   └── reimbursements/
│   │       ├── reimbursement.controller.ts          # NEW — /my/reimbursements* (US8)
│   │       ├── reimbursement.service.ts              # NEW — research.md §10
│   │       └── dto/
│   ├── projects/
│   │   ├── projects.module.ts                      # NEW
│   │   └── sites/sites.service.ts                  # NEW — exported geofence/holiday lookups
│   └── payroll/
│       ├── payroll.module.ts                       # NEW (or extends an existing stub)
│       └── salary/
│           ├── salary.controller.ts                 # NEW — /my/salary*
│           ├── salary.service.ts                    # NEW
│           └── salary-pdf.service.ts                 # NEW — pdfkit rendering
└── test/
    └── my-workspace.e2e-spec.ts                     # NEW
```

**Structure Decision**: Single NestJS project (`buildcore-api`), adding three new top-level modules
(`hr`, `projects`, `payroll`) alongside the existing `auth`/`settings`. The three new Postgres
schemas are the structural database addition, via the same Prisma multi-schema mechanism features
001/002 already use.

## Complexity Tracking

*No entries — the two new dependencies are pre-approved via constitution amendment (v1.1.0), not
undocumented violations; no other constitution deviation exists (see Constitution Check above).*

---

## Amendment 2026-09-01 — calendar days, open-punch state, reimbursement wiring

**Scope**: changes to an already-shipped feature, recorded in place. No new artifacts;
`research.md` and `data-model.md` are unaffected — no entity changed shape and the timezone
decision is recorded here rather than as a fresh research question.

### 1. Calendar days are reckoned in a configured zone (FR-018a)

**The defect.** A calendar day was derived from an instant with `toISOString()`, which means UTC.
At UTC+5:30 that files every punch before 05:30 local under the previous date, taking that shift's
attendance and overtime with it. Found from a real punch at 00:07 IST appearing under the previous
day and the day itself reading "Absent".

**Decision**: one configured application-wide zone (`APP_TIMEZONE`, default `Asia/Kolkata`), not a
per-company or per-site column. Everything statutory in this system is already India-specific —
GSTIN, PAN, PF/ESIC, BOCW, April–March financial years — so a single zone is an honest assumption,
and an explicit one is strictly better than the accidental UTC it replaces. A per-company column
remains the migration path if BuildCore ever serves companies outside India.

**Design**: the fix is at the boundary, not in the calendar-string helpers. `toDateOnly` and
`parseDateOnly` keep operating on `YYYY-MM-DD` and `@db.Date` values that genuinely are UTC
midnight, which is correct and DST-free — the existing design was right. Two helpers sit beside
them for the conversions that were wrong: `zonedDateOnly()` (which day an instant belongs to) and
`zonedDayBounds()` (the instants bounding a local day, for range queries). The offset is measured
per date rather than assumed, so a DST zone yields 23- or 25-hour days.

**Known gap**: the frontend keeps its own `financialYearOf` and uses browser-local time for
"today". That agrees with IST for the current userbase, so nothing is wrong today — but it is a
second, independent definition of the day boundary that nothing keeps in sync with `APP_TIMEZONE`.

### 2. Open-punch state is readable (FR-008b)

`GET /my/punch/open`. The "one open punch-in at a time" rule spans days, so a client inferring it
from today's attendance row offers a punch-in the server refuses, with an error naming a punch the
employee cannot see. The endpoint answers from the same `closedByPunchId IS NULL` condition the
rule is enforced against, so the two cannot drift.

### 3. Reimbursements became wireable (FR-029a, FR-029b)

US8's backend was complete but unreachable from a UI: nothing exposed the category list, and
`receiptRef` was a storage reference the backend never produced for receipts, making every claim
above a threshold unfileable. Added the categories read and in-request receipt upload.

Receipt upload is deliberately part of the create/edit request rather than a separate endpoint: a
two-step upload orphans a blob for every claim the employee abandons, and nothing here would ever
collect them. Receipts are normalised through the same `sharp` pass as enrolment photos, which
strips EXIF — a receipt photographed on site otherwise carries GPS coordinates into storage,
outside the audited location path FR-026 exists to protect.

### 4. Local blob storage is fatal in production (FR-026a)

Was a warning that let the app boot and silently lose every photo on the next deploy. Now refuses
to start, with an explicit `ALLOW_LOCAL_STORAGE` opt-out for preview deployments — following the
same shape `EmailModule` already uses for its console-transport refusal.

**Constitution check (re-evaluated)**: no new violations. Principle III is better served than
before — the timezone was previously an accidental constant inside `toISOString()` and is now
named configuration. Principle IV is strengthened by the receipt EXIF strip and the storage
refusal. Principles I, II, V, VI unaffected.

---

## Amendment 2026-09-01 (b) — one punch-in and one punch-out per day (FR-008)

**Scope**: tightens an already-shipped rule. Amends `plan.md`, `spec.md`, `data-model.md` and the
API contract in place; adds one migration. `research.md` is unaffected — no new technology decision
was taken.

### 1. The rule, and where it is enforced

FR-008 changes from "one *open* punch-in at a time" to "one punch-in and one punch-out per calendar
day". The day is the employee's, in the configured zone (FR-018a), so this is stamped with
`zonedDateOnly()` rather than derived from UTC.

Enforced in two places, deliberately asymmetric:

- **The service check considers every punch on that day, whatever its source.** The rule is about
  the day's record, not about who wrote it — an employee should not get a second punch-in because
  the first was entered by HR.
- **The database index binds only `source = 'employee'`** (the user's decision). It exists to close
  the check-then-insert race and out-of-band writes, not to legislate what feature 005 may do.

### 2. Why a stored `punchDate` rather than an expression index

`capturedAt AT TIME ZONE '<named zone>'` is STABLE, not IMMUTABLE — Postgres will not build a
unique index on it, because the tz database can change underneath. So the calendar day is stamped
into a `date` column at insert, by the same helper the rest of the feature uses.

The consequence, accepted: a later change to `APP_TIMEZONE` does not reclassify punches already
recorded. For payroll data that is the safer direction — a historical attendance record silently
moving to a different day when a config value changes would be worse than it staying put.

### 3. The old index must be dropped, not kept alongside

`PunchRecord_one_open_punch_in_per_employee` (unique on `employeeId` where `type = 'in' AND
closedByPunchId IS NULL`) **contradicts FR-008a**. FR-008a requires a stale open punch-in from an
earlier day to stop blocking today, which means two open punch-in rows must be allowed to coexist —
precisely what that index forbids. Keeping both would make FR-008a unimplementable, and the failure
would surface as a raw unique-violation on a legitimate punch.

Its rule is subsumed: a day admits at most one punch-in, so within a day nothing changes.

### 4. Migration shape

One migration, in this order:

1. Add the `PunchSource` enum and a `source` column defaulting to `employee`.
2. Add `punchDate`, backfilled for existing rows from `capturedAt` at the default zone.
3. Set every pre-existing row's `source` to `legacy`. This is what makes step 5 possible: the
   current data already contains multiple pairs on a day, and the user's decision is to leave it
   and enforce going forward. Marking it `legacy` excludes it from the new index without deleting
   anything.
4. Drop `PunchRecord_one_open_punch_in_per_employee` (§3).
5. Create the partial unique index on `(employeeId, type, punchDate) WHERE source = 'employee'`.

Step 5 must be verified against real data before shipping — if any row is still `employee` and
duplicated, index creation fails and the deploy stops. That is the correct failure, but it should
be discovered locally, not on Render.

### 5. Status code: 400 → 409

Every FR-008 refusal becomes `409 Conflict`, including the existing unmatched-punch-out case which
returns 400 today. The request is well-formed; the recorded state forbids it. This changes existing
e2e assertions, and the frontend gains a 409 branch alongside its existing 423 (payroll lock).

### 6. `GET /my/punch/open` becomes today's state

`{ punchedInAt, punchedOutAt, isComplete }` rather than an open-punch record. The screen's question
is no longer "is a punch open" but "what, if anything, can I do today" — and a stale open punch-in
from an earlier day must not appear, since it is neither actionable nor closable.

### 7. Offline sync collision

A queued punch that drains onto a day already holding a punch of that type is refused like any
other duplicate and surfaced once through the existing sync-failure path. The recorded punch wins;
the employee is told the queued one did not count and can raise an exception. Silently replacing a
punch they have already seen would be worse than telling them.

### 8. Frontend

Once `isComplete`, the Punch screen shows the day's in time, out time and worked hours with **no**
control (FR-019c) — not a disabled button, which advertises an action that can never happen. While
a shift is open it says when it started (FR-019d).

**Constitution check (re-evaluated)**: no new violations. Principle III holds — the zone stays
configuration, and the migration's one hardcoded zone is a one-off backfill of historical rows, not
a runtime value. Principle IV unaffected. The migration is additive and reversible except for the
dropped index, which is recreated by nothing else and is documented above as deliberate.

**Risk**: the dropped index is the only rollback hazard. Reverting this migration restores it, and
if by then two open punch-ins exist (which FR-008a now permits), that restore fails. Anyone rolling
back must close or delete the surplus open punch-in first.
