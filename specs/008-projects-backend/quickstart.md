# Quickstart: Validating the Projects Backend

## Prerequisites

- Seeded company (002), at least one Site row from 003 (already in `projects` schema with
  geofence data; this feature adds `projectId`/`address`/`status` to it), an admin session token.
- Local Postgres migrations applied: 11 new `projects` schema tables, `projectId`/`address`/
  `status` columns added to the existing `Site` (geofence columns untouched), `Permission` enum
  extended with `DWR`/`PROJECT_FINANCIALS` (`PROJECTS` already existed).

---

## Scenario 1 — Clients and Sites (User Stories 1 & 2)

1. `POST /projects/clients` with Name, Contact, Phone, Email, GSTIN. **Expected**: 201.
2. `POST /projects/clients` with the same GSTIN. **Expected**: 409 (duplicate GSTIN).
3. `GET /projects/clients?search=<name>`. **Expected**: the created client in results.
4. `POST /projects/sites` with the `projectId` from Scenario 2, Address, Latitude, Longitude, and
   GeofenceRadiusMeters. **Expected**: 201; `GET /projects/sites/:id` returns both this feature's
   fields (`projectId`, `address`, `status`) and 003's pre-existing geofence fields.
5. Attempt an HR attendance punch (003's `/my/punch`) from a location outside the geofence
   radius. **Expected**: HR's attendance module returns a geofence-exception flag — unchanged
   behaviour, since HR was already reading real radius data from 003 via `SitesService
   .getGeofence()` before this feature existed.

---

## Scenario 2 — Project Portfolio (User Story 3)

1. `POST /projects` with `clientId` from Scenario 1, no `code`. **Expected**: 201, `code`
   auto-generated (e.g. `PRJ-001`).
2. `GET /projects?status=planning`. **Expected**: the project in results.
3. `GET /projects/:id`. **Expected**: `tabs.employees`, `tabs.machinery`, `tabs.materials` all
   return arrays (empty at this point); `tabs.dwrSummary.count = 0`.
4. `PATCH /projects/:id` with `{ isLocked: true }`. **Expected**: 200; subsequent `POST
   /projects/dwr` against this project returns 423.
5. `PATCH /projects/:id` with `{ isLocked: false }`. **Expected**: 200; DWR creation is now
   permitted again (Scenario 3).

---

## Scenario 3 — BOQ and DWR (User Stories 4 & 5)

1. `POST /projects/:id/boq/groups` with BOQ No., Name, Scope Qty. **Expected**: 201.
2. `POST /projects/:id/boq/items` with the groupId, Scope Qty 100, Per Day Qty 10. **Expected**:
   201; `GET /projects/:id/boq` shows `doneQty: 0`, `pendingQty: 100`.
3. `POST /projects/:id/boq/import/validate` with a 5-row Excel file (one row missing the Unit
   column). **Expected**: `{ batchId: "...", validRowCount: 4,
   errors: [{ row: 3, column: "Unit", reason: "required" }], errorReportUrl: "..." }` — nothing
   written yet (`GET /projects/:id/boq` still shows only the item from step 2).
   `POST /projects/:id/boq/import/confirm` with that `batchId`. **Expected**:
   `{ imported: 4 }`; the 4 valid rows now appear in `GET /projects/:id/boq`.
4. `POST /projects/dwr` with the BOQ item, and task fields `nos1:2, nos2:1, length:10, breadth:1,
   depth:1, density:1`. **Expected**: 201, `actualQty = 20`.
5. `PATCH /projects/dwr/:id` with `{ status: "submitted" }`. **Expected**: 200; `GET
   /projects/:id/boq` still shows `doneQty: 0`, `pendingQty: 100` (only Approved DWRs count —
   master PRD §7.5.3).
6. `PATCH /projects/dwr/:id/approve`. **Expected**: 200, DWR status = `approved`; **now** `GET
   /projects/:id/boq` shows `doneQty: 20`, `pendingQty: 80`.

---

## Scenario 4 — Revenue, RA Bills, Budget, P&L (User Stories 6 & 7)

1. `POST /projects/:id/revenue` with `{ amount: 500000, status: "received" }`. **Expected**: 201.
2. `POST /projects/:id/ra-bills` with `{ billNumber: "RA-001", amount: 200000 }`. **Expected**:
   201, `status: "draft"`.
3. `PATCH /projects/:id/ra-bills/:billId/submit`. **Expected**: 200, `status: "submitted"`.
4. `PATCH /projects/:id/ra-bills/:billId/approve`. **Expected**: 200, `status: "approved"`.
5. `PATCH /projects/:id/ra-bills/:billId/approve` again. **Expected**: 409 (already approved).
6. `PUT /projects/:id/budget` with `{ budgets: [{ category: "labour", amount: 300000 },
   { category: "materials", amount: 150000 }] }`. **Expected**: 200; `GET /projects/:id/budget`
   returns both rows.
7. `GET /projects/:id/pnl?period=cumulative`. **Expected**: `revenueBooked = 700000` (500k revenue
   + 200k approved RA bill); `costBreakdown` rows for `machinery`/`fuel`/`labour` reflect real
   seeded 006/005 data (0 if none seeded); `materials`/`subcontractors` rows show `actual: 0` with
   `unavailableModules: ['inventory', 'partners']` (the two still-stubbed sources);
   `grossProfit = revenueBooked − sum(all actual cost rows)`.

---

## Scenario 5 — Project Documents (User Story 8)

1. `POST /projects/:id/documents` (multipart) with `documentType: "gst"` and a PDF file.
   **Expected**: 201.
2. `GET /projects/:id/documents`. **Expected**: the document row with `documentType`, `filePath`.
3. `DELETE /projects/:id/documents/:docId`. **Expected**: 200.
4. `PATCH /projects/:id` with `{ isLocked: true }`, then `POST /projects/:id/documents`.
   **Expected**: 423.

---

## Scenario 6 — Lock enforcement across endpoints

1. Lock a project. Then attempt:
   - `POST /projects/dwr` → **Expected**: 423
   - `POST /projects/:id/revenue` → **Expected**: 423
   - `POST /projects/:id/ra-bills` → **Expected**: 423
   - `POST /projects/:id/boq/items` → **Expected**: 423
   - `PUT /projects/:id/budget` → **Expected**: 423
   - `GET /projects/:id` → **Expected**: 200 (reads are never blocked)
