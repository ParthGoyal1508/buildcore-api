# Implementation Plan: Inventory Backend (Stock, Purchases, Issues, Transfers, Payments)

**Branch**: `009-inventory-backend` | **Date**: 2026-08-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/009-inventory-backend/spec.md`

## Summary

Build the `inventory` schema — 10 entities, ledger-based stock tracking using dual-write
(`StockBalance` for O(1) reads + `StockLedgerEntry` for audit), `SELECT FOR UPDATE` concurrency
on issue/transfer, WAR incremental update on purchase and full-replay on deletion, atomic payment-
bill allocation, and the exported `getMaterialCostByProject()` method that resolves 008's P&L
Materials stub. Three new `Permission` enum values. One cross-module stub added to `ProjectsModule`.
See [research.md](research.md) for all 11 decisions.

## Technical Context

**Language/Version**: TypeScript 5.1, Node.js, NestJS 10, Prisma 5 against PostgreSQL — unchanged.

**Primary Dependencies**: Existing — `class-validator`/`class-transformer`, `@nestjs/swagger`,
001/002's guards, 005/007/008's object-storage pattern for bill file uploads. First use of Prisma
`$queryRaw` for `SELECT FOR UPDATE` (pre-approved — Prisma raw SQL, not a new package).

**Storage**: PostgreSQL via Prisma — new `inventory` schema with 10 tables.

**Testing**: Jest unit tests for `StockService.recomputeWAR()`, `StockService.toRow()`,
`PaymentService` allocation validation. E2e in `test/inventory.e2e-spec.ts` for purchase
create/delete, issue concurrency check, payment allocation + reversal.

**Target Platform**: Linux server (Node.js), same as rest of `buildcore-api`.

**Performance Goals**: `GET /inventory/stock` under 500ms for 500 item-site rows (O(1) reads
from `StockBalance`). `getMaterialCostByProject()` under 1 second for 500 purchases (SC-005).

**Constraints**: `inventory` schema never queries `projects`/`partners` schemas directly —
only via exported service calls (Principle I); `StockLedgerEntry` is append-only — no updates
or hard deletes permitted; `SELECT FOR UPDATE` via `$queryRaw` for issue/transfer validation
(research.md §4); all 10 tables `companyId`-scoped with RLS (Principle IV); `stockValue` never
stored (research.md §11); payment allocation atomic (research.md §7).

**Scale/Scope**: 10 new tables, ~20 endpoints, 3 new Permission enum values, 1 exported P&L
service method, 1 cross-module stub added to ProjectsModule.

## Constitution Check

| Principle | Check | Status |
|---|---|---|
| I. Schema-Per-Module Boundaries | All 10 tables in `inventory`. Vendor names via `PartnersService.getVendorById()`. Site resolution via `ProjectsService.getSitesByProject()` stub. No direct cross-schema queries. | PASS |
| II. Validated DTO Contracts | Every endpoint uses typed DTOs. Pre-validation of allocation sums before transaction opens. | PASS |
| III. Centralized Configuration | No hardcoded values. Item code series via `CodeSeriesService`. Permission enum values in Settings' enum file. | PASS |
| IV. Multi-Tenant Isolation | All 10 tables carry `companyId`; RLS on all. `StockBalance` UNIQUE on `(itemId, siteId)` — scoped within company. | PASS |
| V. Authentication & Authorization | Every endpoint behind `JwtAuthGuard` + `@RequirePermission(INVENTORY_STOCK | INVENTORY_PURCHASES | INVENTORY_PAYMENTS)`. | PASS |
| VI. Observability & Safe Migrations | `inventory` schema added in a single migration. All schema changes via `prisma migrate`. `SELECT FOR UPDATE` via `$queryRaw` — no ORM bypass of Prisma's safety model. | PASS |

## Project Structure

```text
src/
├── inventory/
│   ├── inventory.module.ts
│   ├── categories/
│   │   ├── categories.controller.ts
│   │   ├── categories.service.ts
│   │   └── dto/
│   ├── items/
│   │   ├── items.controller.ts
│   │   ├── items.service.ts
│   │   └── dto/
│   ├── stock/
│   │   ├── stock.controller.ts
│   │   ├── stock.service.ts       # dual-write, WAR, SELECT FOR UPDATE, recomputeWAR()
│   │   └── dto/
│   ├── purchases/
│   │   ├── purchases.controller.ts
│   │   ├── purchases.service.ts
│   │   └── dto/
│   ├── issues/
│   │   ├── issues.controller.ts
│   │   ├── issues.service.ts
│   │   └── dto/
│   ├── transfers/
│   │   ├── transfers.controller.ts
│   │   ├── transfers.service.ts
│   │   └── dto/
│   └── payments/
│       ├── payments.controller.ts
│       ├── payments.service.ts
│       └── dto/
├── settings/
│   └── permission.enum.ts          # MODIFIED: +INVENTORY_STOCK, +INVENTORY_PURCHASES,
│                                   #           +INVENTORY_PAYMENTS
src/projects/
│   └── portfolio/projects.service.ts  # MODIFIED: +getSitesByProject() stub export

prisma/schema.prisma                # MODIFIED: inventory schema, 10 new models

test/
└── inventory.e2e-spec.ts          # new
```

## Implementation Phases

### Phase 1: Setup & Schema

- [ ] Extend `settings.Permission` enum: `INVENTORY_STOCK`, `INVENTORY_PURCHASES`,
      `INVENTORY_PAYMENTS`
- [ ] Add all 10 `inventory` schema models to `prisma/schema.prisma` (data-model.md)
- [ ] Generate and apply migration for the `inventory` schema
- [ ] Add RLS policies for all 10 `inventory` tables
- [ ] Extend `shared.AuditLogEntry.entityType` with 6 new inventory values
- [ ] Scaffold `InventoryModule`; export `InventoryService` with stub
      `getMaterialCostByProject()` returning 0 immediately
- [ ] Add `getSitesByProject(projectId): Promise<string[]>` stub to
      `src/projects/portfolio/projects.service.ts` and export from `ProjectsModule` —
      TODO(008) comment (same pattern as 007's T011c)
- [ ] Add `ITEMS` code-series seed entry to `prisma/seed.ts`

**Checkpoint**: Schema, permissions, stubs ready. All phases proceed in parallel.

### Phase 2: US1 & US2 — Item Categories and Items (P1)

- [ ] Category DTOs + `CategoriesService` (uppercase name, delete guard) + `CategoriesController`
- [ ] Item DTOs + `ItemsService` (code-series, unique name, delete guard) + `ItemsController`
- [ ] Unit test: duplicate category → 409; delete linked category → 409

### Phase 3: US3 — Purchases (P1)

- [ ] Purchase + PurchaseBill DTOs + `PurchasesService`: `create` (dual-write, WAR update,
      PurchaseBill creation), `delete` (soft-delete, reversal ledger, WAR replay via
      `StockService.recomputeWAR()`, allocation guard → 409)
- [ ] `PurchasesController` + `PATCH` (date/remarks only)
- [ ] Unit test: WAR incremental formula; WAR replay after deletion
- [ ] E2e test: create purchase → stock balance; delete → balance reverts; delete with
      allocation → 409

### Phase 4: US4 — Issues (P1)

- [ ] Issue DTOs + `IssuesService`: `create` (`SELECT FOR UPDATE` on `StockBalance`, `422` if
      insufficient, dual-write), `delete` (reversal, guard negative-issued check)
- [ ] `IssuesController`
- [ ] E2e test: over-issue → 422 with availableStock; concurrent issues (simulate with 2 rapid
      requests) → exactly one succeeds

### Phase 5: US5 — Transfers (P2)

- [ ] Transfer DTOs + `TransfersService`: `create` (same-site guard → 400, `SELECT FOR UPDATE`,
      atomic dual `StockBalance` update), `delete` (atomic reversal)
- [ ] `TransfersController`

### Phase 6: US6 — Stock View (P1)

- [ ] `StockService.getStock(companyId, filters)` reading from `StockBalance` with
      `toRow()` computing `inStock` + `stockValue`
- [ ] `GET /inventory/stock/:itemId/:siteId` utility endpoint (for Issue/Transfer form hints)
- [ ] `StockController`
- [ ] Unit test: `toRow()` arithmetic; zero-balance row still returned

### Phase 7: US7 — Payments (P2)

- [ ] Payment + PaymentAllocation DTOs + `PaymentsService`: pre-validation (sum ≤ amount,
      per-bill overflow), atomic transaction (payment + allocations + bill updates), delete
      reversal, `GET /inventory/bills` utility
- [ ] `PaymentsController`
- [ ] Unit test: over-allocation → 400; partial allocation → correct bill statuses
- [ ] E2e test: full payment lifecycle; delete reversal

### Phase 8: US8 — getMaterialCostByProject (P3)

- [ ] Replace stub in `InventoryService.getMaterialCostByProject()` with real implementation
      calling `ProjectsService.getSitesByProject()` + purchase sum query; graceful 0 on failure
- [ ] Unit test: correct sum within date range; excludes soft-deleted purchases

### Phase 9: Polish

- [ ] Swagger `@ApiTags('Inventory')` + `@ApiOperation` on all controllers
- [ ] `npm run lint` + `npm run build` clean

## TODO

- `TODO(008)`: Implement real `ProjectsService.getSitesByProject(projectId)` returning actual
  site IDs for a project — required for `getMaterialCostByProject()` to return real values.
