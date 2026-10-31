# Tasks: Opening Stock and Agreed Vendor Rates Import

**Input**: Design documents from `/specs/051-opening-stock-vendor-rates/`
**Prerequisites**: plan.md, spec.md
**Tests**: unit tests for each new service, plus one e2e suite covering both stories.

API paths are relative to `buildcore-api/`; web paths are prefixed `buildcore-web/`.

## Phase 1: Setup

- [x] T001 Provision the local scratch database `buildcore_051` (`CREATE DATABASE … TEMPLATE buildcore_scratch`, `prisma migrate deploy`)

## Phase 2: Foundational

- [x] T002 Add `opening` to `StockLedgerType`, `KL` to `ItemUnit`, and `model OpeningStock` (inventory, unique `[itemId, siteId]`) in prisma/schema.prisma; note the opening exception on `StockLedgerEntry`'s append-only comment
- [x] T003 Write prisma/migrations/20261030100000_opening_stock_kl_unit/migration.sql from `prisma migrate diff` plus the tenant RLS policy; apply to buildcore_051; regenerate the client
- [x] T004 [P] Create src/inventory/imports/sheet-rows.ts (header discovery, cell readers, name keys, `indexByName`) with src/inventory/imports/sheet-rows.spec.ts
- [x] T005 [P] Add `companySites`, `companyItems`, `companyVendors` to src/inventory/inventory-refs.service.ts and `listVendorsForCompany` to src/partners/partners.service.ts

## Phase 3: User Story 1 — Opening stock (P1) 🎯 MVP

**Independent test**: an opening entry shows in stock at its rate with no purchase; a second is refused; it locks after an issue.

- [x] T006 [US1] Teach `recomputeWAR` the `opening` type (src/inventory/stock/stock.service.ts) and add a unit case in stock.service.spec.ts
- [x] T007 [US1] Add `opening` to `DIRECTION`/`LABEL` in src/inventory/stock/stock-query.service.ts ("Opening stock" ledger line)
- [x] T008 [US1] DTOs in src/inventory/opening-stock/dto/opening-stock.dto.ts
- [x] T009 [US1] src/inventory/opening-stock/opening-stock.service.ts: list, create, replace, remove, set-based `post`, `movedSince`, audit
- [x] T010 [US1] src/inventory/opening-stock/opening-stock.controller.ts; register in src/inventory/inventory.module.ts

## Phase 4: User Story 2 — Opening stock import (P1)

- [x] T011 [US2] `validateImport`, `confirmImport`, `template` in opening-stock.service.ts; validate/confirm/template routes
- [x] T012 [US2] Unit tests src/inventory/opening-stock/opening-stock.service.spec.ts
- [x] T013 [US2] Add the import routes to the known upload routes in src/common/uploads/large-body-routes.spec.ts

## Phase 5: User Story 3 — Agreed vendor rates import (P1)

- [x] T014 [US3] `recordAgreed` in src/inventory/rates/vendor-item-rate.service.ts
- [x] T015 [US3] src/inventory/rates/agreed-rates.service.ts (list, validate, confirm, template) and dto/agreed-rate.dto.ts
- [x] T016 [US3] src/inventory/rates/agreed-rates.controller.ts; register in inventory.module.ts
- [x] T017 [US3] Unit tests src/inventory/rates/agreed-rates.service.spec.ts

## Phase 6: User Story 4 — KL unit (P2)

- [x] T018 [US4] `ItemUnit.KL` (T002/T003); update the unit description in src/settings/item-masters/dto/item.dto.ts
- [x] T019 [P] [US4] buildcore-web/app/lib/constants.ts: `KL` in `ITEM_UNITS`, `ITEM_UNIT_LABELS`; show labels in buildcore-web/app/ui/inventory/masters-modal.tsx and composite-items-tab.tsx

## Phase 7: Web

- [x] T020 [P] buildcore-web/app/lib/api/inventory.ts: opening stock and agreed rate schemas and calls
- [x] T021 buildcore-web/app/lib/constants.ts: routes, `OPENING_STOCK_COPY`, `AGREED_RATE_COPY`; tabs in buildcore-web/app/ui/inventory/inventory-nav.tsx
- [x] T022 buildcore-web/app/dashboard/inventory/opening-stock/page.tsx and buildcore-web/app/ui/inventory/opening-stock-modals.tsx (list, add, replace, delete, import report, template)
- [x] T023 buildcore-web/app/dashboard/inventory/agreed-rates/page.tsx (list, vendor filter, import report, template)

## Phase 8: Polish & verification

- [x] T024 e2e test/opening-stock-vendor-rates.e2e-spec.ts (14 cases) on buildcore_051; re-run inventory, vendor-item-rate-rls, daily-item-rates, site-entries
- [x] T025 Lint and typecheck in both repos; full API unit suite
- [x] T026 Check each screen in a browser against the local API: desktop and phone
