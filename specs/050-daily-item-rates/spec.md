# Feature Specification: Daily-Changing Item Rates (Diesel, Cement)

**Feature Branch**: `050-daily-item-rates`
**Created**: 2026-10-29
**Status**: Implemented

**Input** (the user, verbatim, Hinglish): "there are some items whose rates are changing on a day basis, so we need an option to update those, like DIESEL or CEMENT, toh har baar vendor ki rate change karne padenge" (otherwise we'd have to change the vendor's rate every time).

## What exploring the codebase found

- **Vendor rates are a contract, and they lock purchases.** `inventory.VendorItemRate` (028) is a dated history per vendor and item. The first purchase of a pair establishes the rate. After that, every purchase must match the rate in force (`effectiveTo IS NULL`), or it is refused with `409 PURCHASE_RATE_FIXED` ("raise a rate change and have it approved"). The comparison uses the *current* rate, not the rate on the purchase date.
- **Nothing can change an agreed rate.** No endpoint or screen edits `VendorItemRate`. The `purchase_rate_change` approval chain exists, but nothing submits to it. So the first diesel purchase fixed the diesel rate for that pump for good, and every later price was refused. That is the user's complaint, in a sharper form than they put it.
- **No rate is prefilled anywhere.** The purchase form's rate is typed, and only a PO line's rate is offered when receiving against a PO. PO lines (the letters composer) are typed. Machinery fuel entries (`plant.FuelEntry`: quantity, rate or amount, pump `vendorId`) are typed and are not linked to any inventory item.
- **Permissions**: purchases, and with them the vendor rates they establish, are gated by `INVENTORY` (read/write by HTTP method). The item master is gated by `SETTINGS` (reads also by `INVENTORY`). Fuel is gated by `FUEL`.
- **Precedent for dated history**: `HireRate` and `VendorItemRate` use `effectiveFrom` plus an open end. Plant already imports `InventoryModule`, so Machinery can call an exported Inventory service (Principle I).

## Requirements

- **FR-001** An item can be marked **"Rate changes daily"** (`Item.dailyRate`), and at most one item per company can be marked **"Machine fuel (diesel)"** (`Item.machineFuel`, which implies `dailyRate`).
- **FR-002** A daily-rate item's rates are kept as dated history (`inventory.ItemDailyRate`). Each day has one **market rate** (company-wide) and an optional **override** per vendor. The rate in force on a date is the latest row on or before it. For a vendor, the newer of its override and the market rate wins, and a tie goes to the vendor.
- **FR-003** **Update today's rates** (Inventory → Daily rates) lists every daily-rate item, opened on the rate in force (yesterday's until today's is saved). Under each item it lists every vendor that has supplied it, has an agreed rate for it, or has an override. One edit to the market rate updates every vendor. A vendor's own figure is entered only where it differs. Any past date can be chosen to correct it, and a future date is refused.
- **FR-004** Purchases, purchase-order lines and Machinery fuel entries are **offered** the rate in force on their date, using the vendor's or pump's override where newer. The rate stays editable on the document.
- **FR-005** A purchase of a daily-rate item is **not** held to the 028 agreed-rate lock and does not establish an agreed rate.
- **FR-006** Nothing already recorded is rewritten. Purchases, POs and fuel entries keep the rate they were saved with.
- **FR-007** History is visible per item, newest first, with the market rate and each vendor's overrides.
- **FR-008** Setting rates is audited. Permissions reuse `INVENTORY`: read to see or be offered rates, write to set them. Flags are set in the item master (`SETTINGS`). The fuel offer is under `FUEL`.

## Clarifications (decision log)

### Session 2026-10-29 — decided by implementer; the user asked for no clarification rounds

- Q: Should rates be per vendor, or a market rate with vendor overrides? → A: A company-wide **market rate with optional vendor overrides**, and the newer of the two applies. (decided by implementer, 2026-10-29. Diesel and cement move with the market, so all pumps and dealers move together, and the user's complaint was having to touch each vendor. Per-vendor-only history would bring back exactly that. Overrides cover a dealer who really charges differently. "Newer wins" means today's market update is not masked by an override from last week)
- Q: Extend `VendorItemRate` (the 028 agreed rate) instead of adding a table? → A: No, a separate `ItemDailyRate`. (decided by implementer, 2026-10-29. An agreed rate is a contract that locks purchases until an approved change, and its history is one row per change per vendor. A daily price only offers a figure and never refuses one. Mixing the two would either lock daily purchases, which is today's bug, or quietly weaken the 028 control for cement bought on contract)
- Q: Are daily-rate purchases still checked against the agreed rate? → A: No. A daily-rate item skips `assertMatchesAgreed` and never `establish`es an agreed rate. Ordinary items are unchanged. (decided by implementer, 2026-10-29. Otherwise the first purchase locks the price and the next day's purchase is refused, which is the complaint. The e2e suite proves an ordinary item still gets `409 PURCHASE_RATE_FIXED`)
- Q: Is a purchase refused when its rate differs from the day's rate? → A: No. The rate is offered and editable: "still editable on the document". The difference is visible because the form shows the offered rate under the field. (decided by implementer, 2026-10-29. The bill is the truth, and a pump that charged 10 paise more should not block the receipt)
- Q: Which vendors appear on the board? → A: Vendors with a purchase of the item, an agreed (028) rate for it, or a daily override. (decided by implementer, 2026-10-29. Those are "the vendors where vendor rates exist" in practice. Listing every vendor of the company would bury the few that sell diesel)
- Q: How is the fuel entry's diesel found? → A: An explicit **Machine fuel** flag on one item per company. Marking a new one clears the old one, and it implies "rate changes daily". (decided by implementer, 2026-10-29. `FuelEntry` has no item link, and guessing by name, such as "DIESEL" or "HSD", is fragile. The flag is one checkbox in the item master. The pump on the fuel entry selects that pump's override)
- Q: Fuel offer endpoint: should it live in Inventory or Machinery? → A: `GET /plant/fuel/rate` under `FUEL`, which calls the exported `DailyRatesService`. (decided by implementer, 2026-10-29. A Machinery clerk holds `FUEL`, not `INVENTORY`, and Principle I keeps the read behind Inventory's own service)
- Q: Should the server apply the daily rate when a document omits it? → A: No. The rate stays required on purchases (and rate-or-amount on fuel). The web prefills it. (decided by implementer, 2026-10-29. What is stored is always what somebody confirmed, and existing API callers are unchanged)
- Q: How do you correct a day? → A: Save again for that date. The day's row is replaced, not duplicated, and audited. A blank vendor field removes that day's override. (decided by implementer, 2026-10-29, one value per item, vendor and day keeps the history readable)
- Q: Can a rate be set for a future date? → A: No (400). (decided by implementer, 2026-10-29, rates are set when known. A future row would silently change the offer on the day it arrives)
- Q: Is setting a rate approval-gated? → A: No. It is audited as an `ITEM` update with the day's rates. (decided by implementer, 2026-10-29. A daily price needing a Director's approval every morning would not be used. The unused `purchase_rate_change` chain stays for the 028 contract rate)
- Q: Who may flag an item? → A: The item master's `SETTINGS`, like every other item property. Setting rates needs `INVENTORY` write. (decided by implementer, 2026-10-29. This reuses the inventory permission that governs vendor rates, as asked, and leaves the master where it is)
- Q: What does a PO line get? → A: A PO line added for a daily-rate item opens at today's rate for the PO's vendor (a PO is composed and issued today), with the rate shown under the field. (decided by implementer, 2026-10-29)

## API

- `GET  /inventory/daily-rates?date=` — the board (`INVENTORY` read).
- `PUT  /inventory/daily-rates` — `{ date, rates: [{ itemId, vendorId?, rate | null }] }` (`INVENTORY` write). Returns the board for that date.
- `GET  /inventory/daily-rates/effective?itemId&vendorId?&date` — `{ dailyRate: true, rate, effectiveFrom, source }` or `{ dailyRate: false }`.
- `GET  /inventory/daily-rates/history?itemId&from?&to?` — newest first, with `Market rate` or the vendor's name.
- `GET  /plant/fuel/rate?date&equipmentId?&vendorId?` — the machine fuel item's offered rate (`FUEL`).
- `POST/PATCH /inventory/items` accept `dailyRate` and `machineFuel`, and `GET /inventory/items?dailyRate=true` filters on it. Item views carry both flags.

## Migration

`20261029100000_item_daily_rates`:
- adds `settings.Item.dailyRate` and `settings.Item.machineFuel` (both default false);
- creates `inventory.ItemDailyRate` with the standard tenant RLS policy;
- adds two partial unique indexes: one market row per item per day, and one row per vendor per item per day.

The DDL comes from `prisma migrate diff` against the scratch database. A pre-existing unrelated index-rename drift (`LeaveLedgerEntry`) that the diff also emitted was left out. The RLS policy and the partial indexes are appended, following the pattern of 037 and 048.

## Verification

- Unit (`daily-rates.service.spec.ts`): newer-of-override-or-market (5 cases), future date refused, and a non-daily item refused. `fuel.service.spec.ts` was updated for the new constructor.
- e2e `daily-item-rates`, 8 cases on a local scratch DB:
  - a daily item is bought at 90 with no agreed rate established, and the pump appears on the board;
  - the market rate is set for yesterday and today and a pump override for today: the board opens on yesterday's figure, and re-saving the same day replaces the row;
  - the offer follows each date and the override, and an ordinary item and a date before any rate get nothing;
  - a purchase keeps the 93.50 paid against an offered 93.20, and yesterday's purchase still reads 90;
  - an ordinary item is still refused with `PURCHASE_RATE_FIXED`;
  - a FUEL-only clerk is offered diesel by date and pump;
  - history is listed, and removing a day's override falls back to the market;
  - a future date, a non-daily item and a caller without `INVENTORY` (403) are refused.
