# Feature Specification: Opening Stock and Agreed Vendor Rates Import

**Feature Branch**: `051-opening-stock-vendor-rates`
**Created**: 2026-10-30
**Status**: Implemented

**Input**: The client filled in inventory workbooks (tabs: Item Categories, Items, Opening Stock, Vendor Rates) to be loaded into production through the API once this ships. Three gaps were found: there is no way to record opening stock, agreed vendor rates cannot be entered up front, and the unit KL (kilolitre, for bitumen) is missing. The user asked for the feature to be built in full, with no clarification rounds, and for decisions to be recorded here.

## What exploring the codebase found

- **Stock only enters through a movement with a document.** `inventory.StockLedgerEntry.type` is `purchase`, `issue`, `transfer_in`/`transfer_out` and their reversals. `StockBalance` keeps `received`, `issued`, `transferIn` and `transferOut` per item and store, plus `avgRate`. `StockService.upsertBalanceForPurchase` moves the weighted average on each receipt, and `recomputeWAR` replays the ledger after a reversal.
- **Booking opening stock as a purchase would be wrong in three ways.** A purchase raises a `PurchaseBill`, so it creates a payable to a vendor for material bought long ago. It needs a vendor. It also establishes the 028 agreed rate for that vendor and item.
- **"In stock" is computed from the four balance columns in eight places**: `stock.types.inStockOf`, `StockService.lockAvailable`, the stock list (twice), `StockQueryService.inStockIds` (raw SQL), the site dashboard, indents, issues and store documents.
- **Agreed rates have no way in except a first purchase.** `VendorItemRateService` (028) says the first purchase of a vendor and item establishes the rate, later purchases must match `currentFor` (`effectiveTo IS NULL`), and a change needs approval. Nothing lists agreed rates in the API or the web either; `agreedAcrossVendors` and `establishedBetween` have no callers.
- **Import precedents.** The BOQ import (008/047) uses a validate step, then confirm against an in-memory batch (`ImportBatchStore`), which only works while the API runs as one instance. The attendance import (005) is stateless: confirm re-validates the same payload and refuses everything if any row is invalid. The equipment master import reads `.xlsx` with `exceljs`, finding the header row by its labels. Uploads are base64 in JSON (`@IsBase64Payload`), which also qualifies the route for the large-body limit.
- **Units** are the Prisma enum `ItemUnit` (settings schema). The API validates them with `@IsEnum(ItemUnit)`, so a new value needs no DTO change. The web lists them in `ITEM_UNITS` (two dropdowns), and labels show the bare code.
- **Permissions**: purchases, stock, daily rates and the vendor rates purchases are held to are all under `INVENTORY` (read/write by HTTP method).

## Requirements

### Opening stock

- **FR-001** An opening entry records, for one **store** (a site) and one **item**: a quantity (> 0, up to 3 decimals), a rate in ₹ per unit (optional, up to 2 decimals) and an **as-on date**. The date defaults to today in the business time zone and cannot be in the future.
- **FR-002** A missing rate is stored as missing. The stock is valued at 0, and the entry is flagged **"no rate"** in the API (`noRate`) and the UI.
- **FR-003** Posting an entry writes a new ledger type, **`opening`**, dated on the as-on date, and adds the quantity to the store's stock and to its weighted average rate like a receipt. No purchase, bill, payable or agreed rate is created.
- **FR-004** There is **one opening entry per item per store**. A second is refused (`409 OPENING_STOCK_EXISTS`, carrying the existing entry's id) until the first is replaced.
- **FR-005** An entry can be **replaced** (quantity, rate, date) or **deleted** only while no other movement of that item at that store has been recorded after it. Otherwise the request is refused with `409 OPENING_STOCK_HAS_MOVEMENTS`. The list marks each entry `editable` accordingly.
- **FR-006** The item ledger (`GET inventory/stock/:itemId/:siteId/ledger`) and its Excel download show the entry as an **"Opening stock"** line.
- **FR-007** **Bulk import** from the client's Opening Stock sheet, with columns `Store / Site`, `Item Name`, `Quantity`, `Rate (₹ per Unit)` and `As On Date` (DD-MM-YYYY, an Excel date cell, or blank for today), in two steps:
  - **validate** reads the file and writes nothing. It reports every row with its matched store and item, figures, `noRate`, whether it replaces an existing entry, and its errors: unmatched store or item, an ambiguous name, an inactive item, a duplicate store and item within the file, a bad or non-positive quantity, a bad rate, a bad or future date, or an existing entry that can no longer be replaced. It also lists each unmatched store and item name once.
  - **confirm** validates again and writes **every row in one transaction, or nothing**. It is refused with `400 OPENING_STOCK_IMPORT_INVALID` (with the report) if any row is in error, and with `409 OPENING_STOCK_EXISTS` if rows would replace existing entries and `replaceExisting` was not set.
  - Store and item names are matched **case- and space-insensitively** within the selected company.
- **FR-008** A JSON endpoint creates a single entry. A template download gives the import columns.
- **FR-009** Permission is `INVENTORY` (validate is a read). Each add, replace and delete is audited, and an import is audited as one entry.
- **FR-010** **Web**: Inventory → **Opening stock** shows the entries (store, item, quantity with unit, rate or "No rate", value, as-on date) with a store filter and totals. Actions are Add, Replace and Delete (while editable, otherwise "Locked"), Import from Excel (validation report before confirm, with an explicit "replace existing" tick when needed) and Download template.

### Agreed vendor rates

- **FR-011** **Import agreed rates** from the client's Vendor Rates sheet, with columns `Vendor Name`, `Item Name`, `Rate (₹ per Unit)` and `Valid From` (DD-MM-YYYY, an Excel date, or blank for today; not in the future). Vendor and item names are matched **ignoring case, spaces and punctuation**.
- **FR-012** Each row is classified as one of:
  - **create**: the pair has no rate in force. Confirm records a `VendorItemRate` with `effectiveFrom` set to Valid From and `establishedByPurchaseId = null`.
  - **unchanged**: the same rate is in force. Nothing is written.
  - **conflict**: a different rate is in force. It is **not overwritten**, because a change goes through the existing approved-change path. The current rate and its date are reported.
  - **daily**: the item is a 050 daily-rate item. Its purchases are not held to agreed rates, so the row is reported and not written.
  - **error**: an unmatched or ambiguous name, a bad or non-positive rate, a bad or future date, or a duplicate pair in the file.
- **FR-013** **confirm** validates again and refuses everything (`400 VENDOR_RATE_IMPORT_INVALID`) if any row is in error. Otherwise it records the create rows in one transaction, re-checking each pair inside it so that a rate established by a purchase in the meantime stands. Conflict, unchanged and daily rows are reported only.
- **FR-014** An imported rate holds purchases **exactly like** one a first purchase established. `PurchasesService` reads it through `currentFor`, refuses a different rate with `409 PURCHASE_RATE_FIXED`, and does not establish a second rate.
- **FR-015** `GET inventory/vendor-rates` lists the rates in force (vendor, item, unit, rate, from) with their **source**: `purchase` or `import`. **Web**: Inventory → **Agreed rates** shows that list with a vendor filter, Import from Excel (report before confirm) and Download template.
- **FR-016** Permission is `INVENTORY`. Recorded rates are audited, one entry per vendor.

### Units

- **FR-017** `KL` (kilolitre) is added to `ItemUnit`. The API accepts it wherever a unit is validated. The web unit pickers list it, and every unit is now shown with its name ("KL — Kilolitre").

## Clarifications (decision log)

### Session 2026-10-30 — decided by implementer; the user asked for no clarification rounds

- Q: Where does opening stock live on the balance: a new `StockBalance.opening` column, or `received`? → A: **`received`**. (decided by implementer, 2026-10-30. "In stock" is computed from the four columns in eight places, two of them SQL. A fifth column would have to be added to every one, and missing one would show wrong stock with no error. An opening count *is* stock received into the store. The ledger still separates it as its own "Opening stock" line, which is where the distinction is read. The cost is that the stock screen's "Received" figure includes opening quantities.)
- Q: Is an opening entry its own record, or only a ledger row? → A: Its own table, `inventory.OpeningStock`, unique on item and store. The ledger row's `referenceId` points at it. (decided by implementer, 2026-10-30. The uniqueness rule needs a key. The list screen needs a missing rate kept apart from a typed 0. And every other ledger type points at a document.)
- Q: What counts as a "later movement" that locks an entry? → A: Any other ledger row for the same item and store **recorded after** the opening row (by `createdAt`), whatever its date. (decided by implementer, 2026-10-30. A movement recorded after the opening was entered may have relied on it; one recorded before could not have. This allows the realistic case: purchases have been entered since April, the opening as on 01-04 is loaded later and then corrected. A rule by date would lock it at once. Purchases recorded later lock it too, which is stricter than strictly needed, but it is what "no later movements" says.)
- Q: The ledger is append-only. How is an opening entry replaced or deleted? → A: Its own ledger row is **removed**, the balance is adjusted, and the weighted average is replayed. No reversal row is appended. (decided by implementer, 2026-10-30. The change is allowed only while nothing follows the entry, so the ledger then reads exactly as if the entry had been right the first time. A reversal pair would leave two noise lines on the item ledger for a typo. The audit log keeps the before and after. The schema comment on `StockLedgerEntry` records this one exception.)
- Q: How is the weighted average set? → A: An item and store whose only history is the opening entry gets its rate outright. Otherwise the average is **replayed from the ledger** (`recomputeWAR`, which now values `opening` like a receipt), so an opening dated before existing purchases is averaged in date order. (decided by implementer, 2026-10-30)
- Q: Which import precedent, the BOQ in-memory batch or the attendance re-validate? → A: **Stateless re-validate**. Confirm takes the same file, validates it again, and writes all or nothing. (decided by implementer, 2026-10-30. The production loader will call these endpoints from a script. A batch id kept in one API instance's memory adds a single-instance constraint and an expiry for no gain, and re-reading a few hundred rows costs milliseconds.)
- Q: How does a few-hundred-row import fit Prisma's 5-second interactive transaction? → A: The write is **set-based**: a fixed number of statements however many rows there are (`unnest` inserts and locks for balances, `createMany` for entries and ledger rows, one `UPDATE … FROM unnest`). Only item-store pairs with other history get a per-pair average replay. (decided by implementer, 2026-10-30, following 008's P2028 lesson. One code path serves the single-entry endpoint and the import.)
- Q: Rows that repeat an existing opening entry? → A: Validate marks them `replaces: true`. Confirm needs `replaceExisting: true` to replace them; without it, it answers 409. (decided by implementer, 2026-10-30, the same explicit-replace shape as 047's BOQ replace)
- Q: An inactive item in the opening sheet? → A: Refused (an error on that row, and 400 on the JSON endpoint). (decided by implementer, 2026-10-30. Stock of a retired item would be invisible in every picker that lists active items.)
- Q: Name matching? → A: Opening stock matches **case- and space-insensitively**, and vendor rates also ignore **punctuation**, as specified. A name that matches two records is an error ("more than one … named"), never a guess. (decided by implementer, 2026-10-30)
- Q: Is a conflicting row a blocking error? → A: No. Conflicts, unchanged rows and daily-rate rows are reported, and confirm records the rest. Only errors block. (decided by implementer, 2026-10-30. The spec says a different rate in force is not overwritten and is reported as a conflict, so the loader can be re-run safely and only the new pairs land.)
- Q: Daily-rate items (050) in the Vendor Rates sheet? → A: Reported as `daily` and not written. (decided by implementer, 2026-10-30. 050 exempts them from the agreed-rate lock, so an agreed rate would never be read. Their price goes on Daily rates.)
- Q: Future dates? → A: Refused for both As On Date and Valid From. (decided by implementer, 2026-10-30. `currentFor` ignores dates, so a future-dated agreed rate would apply at once, contradicting its own date.)
- Q: Is an imported rate's `effectiveFrom` used anywhere? → A: Only for display and history. As in 028, "in force" means `effectiveTo IS NULL`. (decided by implementer, 2026-10-30)
- Q: Audit entity types? → A: Opening entries go under `ITEM`, keyed on the item, as 050's daily rates are. An opening import is one `COMPANY` entry with every row. Imported rates are one `VENDOR` entry per vendor. No new enum value. (decided by implementer, 2026-10-30)
- Q: Where do agreed rates show in the web? → A: A new Inventory tab, **Agreed rates**, next to Daily rates, rather than the vendor page. (decided by implementer, 2026-10-30. Nothing showed agreed rates anywhere. The vendor page lives in Partners, under another permission. The vendor filter gives the per-vendor view.)
- Q: Unit labels? → A: The pickers show "CODE — Name" for every unit, not only KL. (decided by implementer, 2026-10-30. Showing a name for KL alone would look like a mistake beside the bare codes.)

## API

All under `INVENTORY`, with JWT. A cross-company caller may add `?companyId=`; otherwise the caller's selected company is used.

- `GET  /inventory/opening-stock?siteId=` → `{ rows: OpeningStockView[], totals: { value, noRate } }`
- `POST /inventory/opening-stock` with `{ siteId, itemId, quantity, rate?: number|null, asOnDate?: 'YYYY-MM-DD' }` → `OpeningStockView`. 409 `OPENING_STOCK_EXISTS` (`openingStockId`), 400 `OPENING_STOCK_FUTURE_DATE`.
- `PUT  /inventory/opening-stock/:id` with `{ quantity, rate?, asOnDate? }` → `OpeningStockView`. 409 `OPENING_STOCK_HAS_MOVEMENTS`.
- `DELETE /inventory/opening-stock/:id` → `{ id, deleted: true }`. 409 `OPENING_STOCK_HAS_MOVEMENTS`.
- `GET  /inventory/opening-stock/import/template` → `.xlsx`
- `POST /inventory/opening-stock/import/validate` with `{ file: base64 .xlsx, fileName? }` → `{ rows[], summary: { rows, valid, invalid, noRate, replacing, value }, unmatched: { stores, items }, canConfirm }`
- `POST /inventory/opening-stock/import/confirm` with `{ file, fileName?, replaceExisting?: boolean }` → `{ created, replaced, report }`. 400 `OPENING_STOCK_IMPORT_INVALID` (`report`), 409 `OPENING_STOCK_EXISTS`.
- `GET  /inventory/vendor-rates?vendorId=&itemId=` → `{ rows: [{ id, vendorId, vendorName, itemId, itemCode, itemName, unit, rate, effectiveFrom, source }] }`
- `GET  /inventory/vendor-rates/import/template` → `.xlsx`
- `POST /inventory/vendor-rates/import/validate` with `{ file, fileName? }` → `{ rows[] (status create|unchanged|conflict|daily|error, current), summary: { rows, create, unchanged, conflict, daily, error }, unmatched: { vendors, items }, canConfirm }`
- `POST /inventory/vendor-rates/import/confirm` with `{ file, fileName? }` → `{ created, unchanged, conflicts, daily, report }`. 400 `VENDOR_RATE_IMPORT_INVALID` (`report`).

The sheet may be the whole four-tab workbook: the right tab is found by its header row (within its top ten rows). Up to 5,000 data rows.

## Migration

`20261030100000_opening_stock_kl_unit`:
- adds `opening` to `inventory.StockLedgerType` and `KL` to `settings.ItemUnit`;
- creates `inventory.OpeningStock`, unique on (`itemId`, `siteId`), with the standard tenant RLS policy.

The DDL comes from `prisma migrate diff` against the scratch database. The pre-existing unrelated `LeaveLedgerEntry` index-rename drift was left out, as in 050.

## Verification

- Unit tests:
  - `sheet-rows.spec.ts`: dates (DD-MM-YYYY, separators, Excel cells and serials, impossible dates), numbers (grouping, ₹, formulas), name keys, header-row discovery past a title row and another tab, refusals.
  - `opening-stock.service.spec.ts`: matching, no rate, every row error, replace and locked replace, confirm refusals, future date.
  - `agreed-rates.service.spec.ts`: loose matching, unchanged, conflict, daily, errors.
  - `stock.service.spec.ts`: an opening row in the average replay.
- e2e `opening-stock-vendor-rates`, 14 cases on the local scratch DB `buildcore_051`:
  - opening stock moves stock and the average with no purchase or agreed rate;
  - it shows as an "Opening stock" ledger line;
  - a second entry and a future date are refused;
  - replace works, then a later purchase averages (120 @ 410 + 80 @ 460 = 430) and locks the entry;
  - a no-rate entry is flagged, and deleting it leaves no balance;
  - an issue locks an entry;
  - a caller without `INVENTORY` gets 403;
  - the import reports unmatched names, duplicates, bad numbers and dates and writes nothing, then confirms all rows, and replaces only with `replaceExisting`;
  - the template has the client's columns;
  - the vendor rates import reports create, unchanged, error and daily rows, records new rates without overwriting, and purchases are held to an imported rate (`PURCHASE_RATE_FIXED`, then accepted at the agreed figure, with no second rate);
  - the list shows each rate's source.
- The `inventory`, `vendor-item-rate-rls`, `daily-item-rates` and `site-entries` e2e suites still pass.
- Checked by eye in a browser against the local API: the list, the import report with errors, replace confirm, the add form, the vendor rates report and list, the item ledger line, the unit picker, and the phone layout.
