# Implementation Plan: Dashboard & General Backend (Widgets, Notifications, Activity Log, Reports)

**Branch**: `004-dashboard-backend` | **Date**: 2026-08-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-dashboard-backend/spec.md`

## Summary

Build a new `src/dashboard/` NestJS module implementing three parallel, extensible registries
(widgets, notifications, report types) via NestJS multi-provider tokens — the architectural
cornerstone this feature exists to deliver, per the confirmed scope decision. Wire real
computation for every widget/notification/report backed by already-specced data (features
001–003's User/Company/Employee/Attendance/Leave/Face-Enrolment), and register explicit
placeholder providers (returning an `unavailable` state) for everything the PRD names that depends
on a not-yet-built module. Also builds the first read/query endpoint over the shared audit log
(Activity Log), and an async PDF/Excel report-export pipeline via the newly-consumed
`@nestjs/bullmq`. See [research.md](research.md) for the registry pattern and schema-placement
decisions.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — unchanged.

**Primary Dependencies**: Existing — `class-validator`/`class-transformer`, `@nestjs/swagger`,
`@nestjs/config`, `nestjs-prisma`, feature 001/002's guards. New — `@nestjs/bullmq` (already
pre-approved, README-earmarked for exactly this use), `exceljs` (newly pre-approved, constitution
v1.2.0), reusing `pdfkit` (pre-approved by feature 003). Requires adding Redis to local/deploy
infrastructure as BullMQ's backing store (research.md §6).

**Storage**: PostgreSQL via Prisma — adds exactly one table, `ExportJob`, to the existing `shared`
schema (research.md §3); no new named schema. Redis (new infrastructure dependency, for BullMQ
only — not a second application datastore).

**Testing**: Jest unit tests for every widget/notification/report provider's computation logic
(especially the availability-flag boundary) and `test/dashboard.e2e-spec.ts` — this repo's
constitution requires e2e coverage for endpoints touching payroll-adjacent or PII-adjacent data,
which several widgets/reports here do (attendance, leave, employee search).

**Target Platform**: Linux server (Node.js) + Redis, same deployment target as the rest of
`buildcore-api`.

**Project Type**: Web service (backend API) — single NestJS project; adds one new module
(`DashboardModule`) that reads via other modules' exported services, per Principle I.

**Performance Goals**: Full widget-list resolution completes in under 3 seconds under normal load
(up to 500 employees) per spec SC-001 — achieved via parallel (`Promise.all`) provider computation,
not sequential per-widget round trips (research.md §7).

**Constraints**: Every controller method uses a validated DTO (Principle II); `src/dashboard/`
never queries directly into `hr`/`settings`/`projects` schemas — only via each module's exported
service (Principle I, research.md §7); async-export threshold and refresh-interval values
centralized config, never inline (Principle III); every endpoint behind `JwtAuthGuard` +
`@RequirePermission(DASHBOARD | REPORTS)` (Principle V, spec FR-022); `ExportJob` is `companyId`-
scoped and RLS-protected (Principle IV); all schema changes via generated migrations (Principle
VI).

**Scale/Scope**: One new module, ~16 endpoints (incl. Activity Log CSV export — FR-024,
research.md §9), ~12 widget providers (6 real + 6 placeholder), ~4
notification providers (3 real + Export-Ready), ~9 report-type registrations (2 real + 7
placeholder), one new table, one new infrastructure dependency (Redis).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries (NON-NEGOTIABLE) | No new schema; `ExportJob` placed in `shared` (research.md §3), matching `AuditLogEntry`'s existing precedent. Every widget/notification/report provider backed by real data calls another module's exported service — never a direct cross-schema Prisma query (research.md §7). | PASS |
| II. Validated DTO Contracts (NON-NEGOTIABLE) | Every endpoint in contracts/dashboard-api.md uses typed request/response DTOs. | PASS |
| III. Centralized Configuration & No Hardcoded Values (NON-NEGOTIABLE) | Refresh interval (30s), async-export row threshold, and the entityType→module-bucket mapping (data-model.md §Activity Log mapping) all live in centralized config/constants, not inline literals. | PASS |
| IV. Multi-Tenant Isolation & PII Protection (NON-NEGOTIABLE) | `ExportJob` carries `companyId` and is RLS-protected; every widget/report/search result is scoped to the caller's accessible companies (spec FR-008, FR-013, FR-015, FR-016), with the single existing Super Admin cross-company exception honored, not extended. | PASS |
| V. Authentication, Authorization & Secrets Hygiene | Every endpoint behind `JwtAuthGuard` + `@RequirePermission()`, reusing `DASHBOARD`/`REPORTS` — no new permission values (clarification). | PASS |
| VI. Observability & Safe Migrations | The one schema change (`ExportJob`) ships as a generated migration. | PASS |

No violations require a Complexity Tracking entry — `@nestjs/bullmq` and `exceljs` are both
pre-approved (the latter via this feature's own constitution amendment, v1.2.0).

**Post-design re-check (after Phase 1)**: data-model.md and contracts/dashboard-api.md keep the
single new table tenant-scoped, every read going through exported services, and every endpoint
permission-gated per the clarified mapping. Still PASS.

## Project Structure

### Documentation (this feature)

```text
specs/004-dashboard-backend/
├── plan.md                    # This file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
└── contracts/
    └── dashboard-api.md       # Phase 1 output

(tasks.md — Phase 2 output, /speckit-tasks — not created by /speckit-plan)
```

### Source Code (repository root)

```text
buildcore-api/
├── docker-compose.yml (or a new docker-compose.redis.yml)  # MODIFIED — adds Redis service
├── prisma/
│   ├── schema.prisma                             # MODIFIED — `shared.ExportJob` model
│   └── migrations/                                 # NEW migration via `migrate:dev:create`
├── src/
│   ├── common/configs/
│   │   ├── config.ts                              # MODIFIED — DashboardConfig (refresh interval,
│   │   │                                         #   async-export threshold)
│   │   └── config.interface.ts                    # MODIFIED
│   └── dashboard/
│       ├── dashboard.module.ts                     # NEW — registers BullMQ queue, all providers
│       ├── widgets/
│       │   ├── widget.types.ts                    # NEW — WidgetProvider interface, tokens
│       │   ├── company-kpi.providers.ts            # NEW — Total Employees/Present/Absent/On
│       │   │                                     #   Leave/Pending Approvals (real)
│       │   ├── attendance-table.provider.ts        # NEW — Today's Attendance (real)
│       │   ├── recent-leaves-table.provider.ts     # NEW — real
│       │   ├── muster-stat.provider.ts             # NEW — Employees on Muster (real)
│       │   ├── site-widgets.providers.ts           # NEW — Workers Today, site attendance (real)
│       │   ├── group-company-card.provider.ts      # NEW — Headcount real, rest unavailable
│       │   └── unbuilt-module.placeholders.ts      # NEW — every not-yet-computable widget
│       │                                          #   (Machinery/Projects/Inventory/Fuel/etc.),
│       │                                          #   all `isAvailable(): false`
│       ├── notifications/
│       │   ├── notification.types.ts               # NEW
│       │   ├── leave-pending.provider.ts            # NEW — real
│       │   ├── reenrolment-pending.provider.ts      # NEW — real
│       │   ├── payroll-pending.provider.ts          # NEW — real
│       │   ├── export-ready.provider.ts             # NEW — real, reads ExportJob
│       │   ├── notifications.controller.ts          # NEW
│       │   └── notifications.service.ts             # NEW
│       ├── activity-log/
│       │   ├── activity-log.controller.ts           # NEW
│       │   ├── activity-log.service.ts               # NEW — reads shared.AuditLogEntry
│       │   └── module-bucket-mapping.ts              # NEW — entityType → PRD module bucket
│       ├── reports/
│       │   ├── report.types.ts                       # NEW
│       │   ├── attendance-report.provider.ts          # NEW — real
│       │   ├── employee-report.provider.ts            # NEW — real
│       │   ├── unbuilt-report.placeholders.ts         # NEW — Payroll/Machinery/Fuel/Project
│       │   │                                        #   Cost/Expense/P&L/Equipment Utilization
│       │   ├── export/
│       │   │   ├── export.processor.ts                # NEW — BullMQ worker (pdfkit/exceljs)
│       │   │   └── export-job.service.ts               # NEW
│       │   └── reports.controller.ts                   # NEW
│       ├── dashboard.controller.ts                      # NEW — /dashboard/widgets
│       ├── group.controller.ts                          # NEW — /group/*
│       └── site-dashboard.controller.ts                 # NEW — /site-dashboard/*
└── test/
    └── dashboard.e2e-spec.ts                             # NEW
```

**Structure Decision**: Single NestJS project (`buildcore-api`), adding one new top-level module
(`src/dashboard/`) that reads other modules via their exported services. The one structural
addition beyond the module itself is a Redis service in local/deploy infrastructure, required by
`@nestjs/bullmq`.

## Complexity Tracking

*No entries — no constitution violations requiring justification; both new dependencies are
pre-approved (see Constitution Check above).*

---

## Amendment 2026-09-01 — Department Dashboard & Cross-Module Reminders Engine

Covers spec FR-025 to FR-037. Adds 2 tables; no new permission value.

**Note**: the reminders engine is centralized here by ratified decision (2026-09-01). Features 002,
006, and 012 register rules rather than implementing their own evaluation — so this amendment
becomes a build-order dependency for all three.

**Constitution re-check**: Principle I — the engine holds no other module's data; rules are
registered by their owning module and evaluated through that module's exported service. Principle
III — lead windows and severity ladders are per-rule configuration. Principle IV — reminders scoped
to the caller's company except `CROSS_COMPANY_ACCESS`. Principle V — reuses `DASHBOARD`, adds
nothing. PASS.

### Phase A1: Schema & Registry

- [ ] Add `ReminderRule` and `ReminderSnooze` models; migration + RLS
- [ ] Build the rule-registration mechanism mirroring the existing widget registry (FR-028) so a
      module contributes a rule without editing this feature — the same extensibility guarantee
      FR-002 gives widgets

### Phase A2: US8 — Department Dashboard (P2)

- [ ] `DepartmentDashboardService` + controller reusing the existing widget contract (FR-025) — no
      new response shape
- [ ] Department-scoped KPIs (headcount, present, absent, on leave, pending approvals, open
      positions from 011, department cost from payroll line items) — FR-026
- [ ] Department selector honouring role-restricted scope (FR-027)
- [ ] Unit test: no cross-department leakage; empty department returns zeros not errors
- [ ] E2e test: unbuilt-module widgets return the FR-003 unavailable state

### Phase A3: US9 — Reminders Engine (P2)

- [ ] `RemindersService`: evaluate all registered rules, unified list with severity, days
      remaining, sorting (FR-029, FR-030); unavailable-module rules contribute nothing (FR-031)
- [ ] De-duplication: at most one notification per entity, per rule, per severity band; escalation
      emits anew; resolution closes the open notification (FR-032, FR-033)
- [ ] Snooze endpoint with audit logging and expiry-despite-escalation semantics (FR-034)
- [ ] Count endpoint by severity, consistent with FR-011
- [ ] Unit test: de-duplication across repeated evaluation; escalation; snooze expiry
- [ ] E2e test: a rule registered by a test module appears in the list without editing this
      feature (SC-A01)
