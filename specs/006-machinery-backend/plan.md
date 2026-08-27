# Implementation Plan: Machinery Backend (Asset Register, Logbook, Fuel, Maintenance, Hire Bills, Equipment Categories, Equipment Doc Types, Hire Rates)

**Branch**: `006-machinery-backend` | **Date**: 2026-08-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-machinery-backend/spec.md`

## Summary

Build the full lifecycle-tracking module for the company's owned and hired equipment fleet: asset
registration with document-expiry tracking, daily logbook entries that drive the machine's live
reading, fuel consumption with automated variance detection, preventive/breakdown maintenance,
hire-bill verification against logbook data, and the module's own reference data (categories, doc
types, effective-dated hire rates). This is the first feature to claim the constitution's
pre-reserved `plant` schema, and the first to need a Vendor concept — creating a minimal `Vendor`
in the not-yet-specced `partners` schema, following the exact "minimal version now, extended
later" precedent feature 003 set for `Site`. It also makes real two of Dashboard's (004) still-
placeholder widget/notification categories by registering new providers into that feature's
existing extensible registries. See [research.md](research.md) for all eleven decisions.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — unchanged.

**Primary Dependencies**: Existing only — `class-validator`/`class-transformer`, `@nestjs/swagger`,
`@nestjs/config`, `nestjs-prisma`, 001/002's guards, 004's `@nestjs/bullmq` wiring (reused for two
new repeatable jobs, research.md §4). No new architectural dependency.

**Storage**: PostgreSQL via Prisma — introduces the `plant` schema (Equipment, EquipmentDocument,
EquipmentCategory, EquipmentDocType, LogbookEntry, FuelEntry, ServiceSchedule, MaintenanceJob,
HireBill, HireRate) and a new minimal `Vendor` table in the `partners` schema. No existing table
from 001–005 is modified.

**Testing**: Jest unit tests for the utilization-percent calculation, the hire-bill variance/TDS
computation, the effective-dated hire-rate resolution (including the non-overlapping-history
invariant), and the maintenance-job open/close status transitions — these are this feature's
highest-stakes computed values. e2e coverage in `test/machinery.e2e-spec.ts` for every endpoint,
per this repo's constitution requiring it for anything touching financial calculations (Hire
Bills/TDS) alongside the module's general endpoint coverage.

**Target Platform**: Linux server (Node.js), same as the rest of `buildcore-api`.

**Project Type**: Web service (backend API) — single NestJS project; adds a new top-level
`machinery` module directory (no prior feature scaffolded one, unlike `hr`/`payroll`).

**Performance Goals**: Equipment registration with an initial document and logbook entry
completable in under 5 minutes (spec SC-005); document-expiry and fuel-variance detection surfaced
within 24 hours of the underlying condition (SC-001, SC-002) via the daily/scheduled jobs, not
real-time computation.

**Constraints**: Every controller method uses a validated DTO (Principle II); `plant` module never
queries directly into `projects`/`hr`/`partners`/`settings`/`shared` schemas — only via exported
services (Principle I, research.md §3); every table `companyId`-scoped and RLS-protected
(Principle IV); Fuel Variance and Hire Bill Variance thresholds are per-category, admin-editable
config, never hardcoded (Principle III, research.md §9); document-expiry and fuel-variance status
computed server-side by scheduled jobs, never client-side (spec NFR, research.md §4); every schema
change via generated migrations (Principle VI).

**Scale/Scope**: 11 new tables (10 in `plant`, 1 minimal `Vendor` in `partners`), ~35 endpoints
across six functional areas plus two background jobs, 6 new `Permission` enum values, 3 new
Dashboard widget-provider registrations, 3 new Dashboard notification-provider registrations. No
existing 001–005 endpoint contract changes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries (NON-NEGOTIABLE) | All new tables land in `plant` (pre-reserved, unclaimed until now) and one minimal table in `partners` (first claimant, same precedent as 003's `Site`); every cross-schema read (`Site`, `Employee`) goes through an exported-service-shaped call, never a direct query (research.md §3). | PASS |
| II. Validated DTO Contracts (NON-NEGOTIABLE) | Every endpoint in contracts/machinery-api.md uses a typed DTO. | PASS |
| III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE) | Fuel Variance and Hire Bill Variance thresholds, remind-days, and utilization-benchmark constants are per-category/company config, never inline (research.md §9, §10). | PASS |
| IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE) | Every new table is `companyId`-scoped and RLS-protected. No regulated-PII fields are introduced by this feature (equipment/financial data, not personal data) — the masking/reveal requirement does not apply here, consistent with how 004 (also non-PII) treated this principle. | PASS |
| V. Authentication, Authorization & Secrets Hygiene | Every endpoint behind `JwtAuthGuard` + `@RequirePermission()`, using six new enum values scoped to this feature's own functional areas (research.md §6). | PASS |
| VI. Observability & Safe Migrations | Schema changes ship as generated migrations, grouped logically (plant schema core tables, then Vendor, then the two scheduled-job-consuming fields) rather than one giant migration. | PASS |

No violations require a Complexity Tracking entry — no new dependencies, no constitution
deviation.

**Post-design re-check (after Phase 1)**: data-model.md and contracts/machinery-api.md keep every
table tenant-scoped, every cross-schema reference read-only via a service-call boundary, every
threshold centralized and admin-configurable, and every endpoint permission-gated with the six new
values. Still PASS.

## Project Structure

### Documentation (this feature)

```text
specs/006-machinery-backend/
├── plan.md                    # This file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
└── contracts/
    └── machinery-api.md       # Phase 1 output

(tasks.md — Phase 2 output, /speckit-tasks — not created by /speckit-plan)
```

### Source Code (repository root)

```text
buildcore-api/
├── prisma/
│   ├── schema.prisma                              # MODIFIED — new plant schema tables, new
│   │                                              #   partners.Vendor, Permission enum extension
│   └── migrations/                                  # NEW migrations (grouped logically —
│                                                    #   Constitution Check VI)
├── src/
│   ├── partners/
│   │   └── vendors/
│   │       ├── vendors.controller.ts                # NEW — minimal CRUD, research.md §2
│   │       └── vendors.service.ts                   # NEW
│   └── machinery/
│       ├── equipment/
│       │   ├── equipment.controller.ts               # NEW
│       │   ├── equipment.service.ts                  # NEW
│       │   ├── utilization.service.ts                # NEW — research.md §10
│       │   └── documents/
│       │       ├── equipment-documents.controller.ts # NEW
│       │       └── equipment-documents.service.ts    # NEW
│       ├── logbook/
│       │   ├── logbook.controller.ts                 # NEW
│       │   └── logbook.service.ts                    # NEW — updates Equipment.currentReading
│       ├── fuel/
│       │   ├── fuel.controller.ts                    # NEW
│       │   ├── fuel.service.ts                       # NEW
│       │   └── fuel-variance.job.ts                  # NEW — BullMQ repeatable job
│       ├── maintenance/
│       │   ├── service-schedules.controller.ts       # NEW
│       │   └── maintenance-jobs.controller.ts        # NEW — open/close status transitions
│       ├── hire-bills/
│       │   ├── hire-bills.controller.ts               # NEW
│       │   └── hire-bills.service.ts                  # NEW — verify/mark-paid, TDS calc
│       ├── categories/
│       │   └── equipment-categories.controller.ts     # NEW
│       ├── doc-types/
│       │   └── equipment-doc-types.controller.ts      # NEW
│       ├── rates/
│       │   └── hire-rates.controller.ts               # NEW — effective-dated history
│       ├── jobs/
│       │   └── document-expiry-scan.job.ts            # NEW — BullMQ repeatable job
│       └── dashboard-providers/
│           ├── machinery-widget.providers.ts          # NEW — registers into 004's
│           │                                          #   WIDGET_PROVIDERS token
│           └── machinery-notification.providers.ts    # NEW — registers into 004's
│                                                      #   NOTIFICATION_PROVIDERS token
└── test/
    └── machinery.e2e-spec.ts                           # NEW
```

**Structure Decision**: Single NestJS project (`buildcore-api`), adding a new top-level `machinery`
module directory (the module's first feature — no prior scaffold to extend, unlike `hr`/
`payroll`), plus a minimal `partners/vendors` directory as the first claim on that schema.

## Complexity Tracking

*No entries — no constitution violations requiring justification (see Constitution Check above).*
