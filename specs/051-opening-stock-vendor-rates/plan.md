# Implementation Plan: Opening Stock and Agreed Vendor Rates Import

**Branch**: `051-opening-stock-vendor-rates` | **Date**: 2026-10-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/051-opening-stock-vendor-rates/spec.md`

## Summary

Add an `opening` stock ledger type, backed by a new `inventory.OpeningStock` record (one per item and store). It counts in `StockBalance.received` and in the weighted average like a receipt, and can be replaced or deleted until a later movement of the pair is recorded. Add a stateless validate → confirm Excel import for opening stock and for agreed vendor rates, which creates `VendorItemRate` rows with no `establishedByPurchaseId` and never overwrites a rate in force. Add a list of agreed rates, the `KL` unit, and two web screens.

## Technical Context

**Language/Version**: TypeScript 5 (NestJS 10 API; Next.js web in `buildcore-web`)

**Primary Dependencies**: Prisma 5.22, class-validator, exceljs (`.xlsx` read and the templates), Zod (web). No new dependency.

**Storage**: PostgreSQL. In the `inventory` schema, one new table and one enum value. In the `settings` schema, one enum value.

**Testing**: Jest unit specs colocated; `test/opening-stock-vendor-rates.e2e-spec.ts` against `buildcore_051`, a local clone of `buildcore_scratch`.

**Target Platform**: Render (API), Vercel (web)

**Performance Goals**: An import's write is a fixed number of statements however many rows there are, plus a replay only for item-store pairs that already have history. A few hundred rows fit the default 5-second interactive transaction.

**Constraints**: No `.xls` (the client's workbook is `.xlsx`; the SheetJS boundary is untouched). At most 5,000 rows per file.

**Scale/Scope**: About 10 API files, about 7 web files, 1 migration.

## Constitution Check

| Principle | Status |
|---|---|
| I. Schema-per-module | PASS. Stores, items and vendors are resolved through `SitesService.listForCompany`, `ItemsService` and a new `PartnersService.listVendorsForCompany`, all via `InventoryRefsService`. No cross-schema query. |
| II. Validated DTOs | PASS. Every body is a class-validator DTO (`@IsBase64Payload` for files, `@IsNumber({maxDecimalPlaces})`, `@IsDateString`), and Swagger is documented. |
| III. No hardcoded values | PASS. Error codes live in `OPENING_STOCK_ERRORS` and `AGREED_RATE_ERRORS`, the columns in `OPENING_STOCK_COLUMNS` and `VENDOR_RATE_COLUMNS`, and the row cap in `MAX_IMPORT_ROWS`. The business time zone comes from config. |
| IV. Tenant isolation | PASS. `OpeningStock` carries `companyId` with the standard `tenant_isolation` RLS policy, and every query runs through `withRlsContext`. Deletes are audited. |
| V. Auth | PASS. `JwtAuthGuard` and `PermissionsGuard(INVENTORY)`. Validate is `@RequireLevel(read)`, like attendance import. |
| VI. Safe migrations | PASS. An additive migration, generated with `prisma migrate diff` against the scratch DB and applied there only. |
| Excel | PASS. exceljs reads `.xlsx` and writes the templates. |

## Design

### Opening stock (`src/inventory/opening-stock/`)

- `OpeningStockService.post(tx, companyId, userId, inputs[], replace)` does all writes, for one row or an import:
  1. `INSERT … SELECT FROM unnest(itemIds, siteIds) ON CONFLICT DO NOTHING` creates balance rows, then `SELECT … FOR UPDATE` locks them all, the same lock every movement takes.
  2. It loads existing entries for the pairs, refuses a replace unless allowed, and refuses one moved since (`movedSince`: the max `createdAt` of non-opening rows per pair, compared with the opening row's own `createdAt`).
  3. It deletes the replaced entries' ledger rows, creates or updates the `OpeningStock` rows, and `createMany`s the ledger rows.
  4. One `UPDATE … FROM unnest(balanceIds, deltas, rates)` adds the quantity delta to `received` and sets `avgRate` outright where the pair has no other history. Pairs with history are replayed with `recomputeWAR`.
- `remove` locks the balance, checks `movedSince`, and deletes the ledger row and entry. If nothing else ever moved, it deletes the balance row; otherwise it decrements `received` and replays the average.
- `validateImport` reads the sheet (`imports/sheet-rows.ts`), matches names, and checks figures, dates, duplicates and replaceability. `confirmImport` re-validates, refuses on any error or an unrequested replace, then calls `post`.
- `StockService.recomputeWAR` treats `opening` like `purchase`. `StockQueryService`'s `DIRECTION` and `LABEL` gain `opening: +1, 'Opening stock'`.

### Agreed rates (`src/inventory/rates/`)

- `VendorItemRateService.recordAgreed(tx, rows)` uses `createMany({ skipDuplicates })` with `establishedByPurchaseId: null`.
- `AgreedRatesService`:
  - `list` reads the rates in force, with names and `source`;
  - `validateImport` loosely matches names and classifies each row against the rates in force;
  - `confirmImport` re-validates, refuses on error, re-reads the rates in force inside the transaction, and records only the pairs still free.

### Shared reader (`src/inventory/imports/sheet-rows.ts`)

The reader finds the header row in any sheet (within the top ten rows) by normalised labels, and returns the data rows (skipping blank ones) as raw cell values. It also provides `cellText`, `cellNumber`, `cellDate` (DD-MM-YYYY with `-`, `/` or `.`, ISO, Excel date cells and serials, round-trip checked), `nameKey`, `looseNameKey` and `indexByName`.

### Web (`buildcore-web`)

- `app/lib/api/inventory.ts`: Zod schemas and calls for both features.
- `app/dashboard/inventory/opening-stock/page.tsx` with `app/ui/inventory/opening-stock-modals.tsx`.
- `app/dashboard/inventory/agreed-rates/page.tsx`.
- `constants.ts`:
  - `KL` in `ITEM_UNITS`, and `ITEM_UNIT_LABELS`;
  - the routes;
  - `OPENING_STOCK_COPY` and `AGREED_RATE_COPY`;
  - two nav tabs, and the unit pickers show the unit names.

Post-design re-check: unchanged, PASS.
