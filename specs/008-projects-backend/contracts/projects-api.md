# Contract: `/projects/*` endpoints

All endpoints require `JwtAuthGuard` plus the matching `@RequirePermission()` value from 002's
`Permission` enum (`PROJECTS` reused; `DWR`/`PROJECT_FINANCIALS` genuinely new, reconciled into
002's own enum definition). No endpoint is public.

Permission groupings:
- `PROJECTS` — portfolio, clients, sites, BOQ, project documents
- `DWR` — daily work reports
- `PROJECT_FINANCIALS` — revenue, RA bills, work orders, budget, P&L

---

## Clients — `/projects/clients` (permission: `PROJECTS`)

- `GET /projects/clients?search=&status=&page=` — paginated list. Response includes `projectCount`
  per client (count from `Project` table).
- `POST /projects/clients` — `{ name, contactPerson, phone, email, address, gstin?, status? }` →
  201 with created client. `409` if `gstin` already exists for this company.
- `PATCH /projects/clients/:id` — partial update of any field. Audit-logged.
- `DELETE /projects/clients/:id` — `409` if client has linked projects; otherwise hard-delete.

---

## Sites — `/projects/sites` (permission: `PROJECTS`)

Site already exists in the `projects` schema (built by 003, with `latitude`/`longitude`/
`geofenceRadiusMeters`/`weeklyOffDay`/`holidays`) — this feature only adds `projectId`/`address`/
`status` management on top of it; no geofence fields are being introduced here.

- `GET /projects/sites?projectId=&status=&page=` — paginated list.
- `POST /projects/sites` — `{ name, projectId?, address?, latitude?, longitude?,
  geofenceRadiusMeters?, weeklyOffDay?, status? }` → 201 (geofence/weekly-off fields accepted here
  since site creation is this feature's endpoint, but their validation/semantics are unchanged
  from 003).
- `GET /projects/sites/:id` — single site including 003's pre-existing geofence/holiday fields.
- `PATCH /projects/sites/:id` — partial update. Audit-logged.
- `DELETE /projects/sites/:id` — `409` if active employees or DWRs reference this site.

---

## Projects — `/projects` (permission: `PROJECTS`)

- `GET /projects?search=&status=&clientId=&page=` — paginated portfolio list.
  Response columns: `id`, `code`, `name`, `client` (name), `location`, `contractValue`, `status`,
  `startDate`, `expectedEndDate`, `isLocked`.
- `POST /projects` — `{ code?, name, clientId, location, contractValue, startDate,
  expectedEndDate?, status, projectManagerEmployeeId?, division, departmentType?, projectType?,
  siteType?, isHO?, cgstApplicable?, purchaseLimit?, orderNumber?, siteStartDate?, description? }`
  → 201. `code` auto-generated via Settings' CodeSeriesService if omitted.
- `GET /projects/:id` — full project detail including aggregated tab data:
  ```json
  {
    "project": { ...all fields },
    "tabs": {
      "employees":  [{ id, name, designation, contact }],
      "machinery":  [{ id, name, type, deployedAt }],
      "materials":  [{ id, itemName, qty, unit }],
      "dwrSummary": { "count": N, "latestDate": "YYYY-MM-DD" },
      "billSummary":{ "totalBills": N, "totalExpenses": N },
      "revenueSummary": { "totalReceived": N, "totalPending": N }
    }
  }
  ```
  Cross-module tab data (employees, machinery, materials) is fetched via exported service calls;
  unavailable modules return empty arrays.
- `PATCH /projects/:id` — partial update. `isLocked` transition audit-logged.
- `DELETE /projects/:id` — `409` if project has DWRs, revenue, RA bills, or BOQ items.

---

## BOQ — `/projects/:id/boq` (permission: `PROJECTS`)

All BOQ write endpoints subject to `ProjectLockGuard` (→ `423` if `isLocked`).

- `GET /projects/:id/boq` — full BOQ tree: groups with their items, each item including computed
  `pendingQty`, `avgQtyPerDay`, `daysToComplete`.
- `POST /projects/:id/boq/groups` — `{ boqNo, name, startDate, finishDate, scopeQty,
  isEstimate? }` → 201.
- `PATCH /projects/:id/boq/groups/:groupId` — partial update.
- `POST /projects/:id/boq/items` — `{ boqNo, groupId, taskName, unit, scopeQty, startDate,
  finishDate, duration, perDayQty, isEstimate? }` → 201.
- `PATCH /projects/:id/boq/items/:itemId` — partial update.
- `DELETE /projects/:id/boq/items/:itemId` — `409` if DWR tasks reference this item.
- `POST /projects/:id/boq/import/validate` — `multipart/form-data` with `file` (Excel). Validates
  only — writes nothing. Returns:
  ```json
  { "batchId": "...", "validRowCount": 42,
    "errors": [{ "row": 5, "column": "Scope Qty", "reason": "not a number" }],
    "errorReportUrl": "https://..." }
  ```
  `413` if file row count > 1,000.
- `POST /projects/:id/boq/import/confirm` — `{ batchId }`. Commits the previously-validated rows
  for that batch. Returns `{ "imported": 42 }`.
- `POST /projects/:id/boq/estimate-import/validate` / `.../confirm` — same two-step pipeline;
  items stored with `isEstimate: true`.
- `GET /projects/:id/boq/alerts` — `{ todayTask: [...], delayed: [...], toBeDelayed: [...] }`.

---

## Daily Work Reports — `/projects/dwr` (permission: `DWR`)

Write endpoints subject to `ProjectLockGuard`.

- `GET /projects/dwr?projectId=&dateFrom=&dateTo=&status=&page=` — paginated DWR list.
- `POST /projects/dwr` — `{ projectId, workDate, supervisorEmployeeId, weather, contractFor,
  contractNumber?, rfiNo?, layer?, workerCount, machineryCount, progress, location?, description?,
  tasks: Array<DWRTaskInput> }` where `DWRTaskInput` = `{ boqItemId?, chainageFrom?, chainageTo?,
  roadSide?, paymentMode, nos1, nos2, length, breadth, depth, density, engineerName?, remark? }`.
  Server computes `actualQty` per task and sets `dprNumber` and `exceedsScope`. → 201.
- `GET /projects/dwr/:id` — full DWR with tasks, BOQ item context per task, attachments.
- `PATCH /projects/dwr/:id` — update draft DWR fields or set `status: 'submitted'`. Submitting
  does **not** move BOQ `doneQty` (master PRD §7.5.3 — only Approved DWRs count).
- `PATCH /projects/dwr/:id/approve` — admin-only; moves `submitted → approved`, audit-logged, and
  **this is the point at which** the BOQ item's `doneQty` increments.
- `DELETE /projects/dwr/:id` — draft only; `409` if submitted/approved.
- `POST /projects/dwr/:id/attachments` — `multipart/form-data` → stores file, returns
  `{ fileRef, url }`.

---

## Revenue — `/projects/:id/revenue` (permission: `PROJECT_FINANCIALS`)

Write endpoints subject to `ProjectLockGuard`.

- `GET /projects/:id/revenue` — list with `description`, `amount`, `date`, `status`.
- `POST /projects/:id/revenue` — `{ description, amount, date, status }` → 201. Audit-logged.
- `PATCH /projects/:id/revenue/:entryId` — update. Audit-logged.
- `DELETE /projects/:id/revenue/:entryId` — hard-delete. Audit-logged.

---

## RA Bills — `/projects/:id/ra-bills` (permission: `PROJECT_FINANCIALS`)

Write endpoints subject to `ProjectLockGuard`. State machine: `draft → submitted → approved`;
`submitted → draft` via reject.

- `GET /projects/:id/ra-bills` — list with status.
- `POST /projects/:id/ra-bills` — `{ billNumber, description?, amount, billingDate }` → 201 with
  `status: 'draft'`.
- `PATCH /projects/:id/ra-bills/:billId` — update draft fields. `409` if not draft.
- `PATCH /projects/:id/ra-bills/:billId/submit` — `draft → submitted`. Audit-logged.
- `PATCH /projects/:id/ra-bills/:billId/approve` — `submitted → approved`. Audit-logged.
  Approved bills become immutable.
- `PATCH /projects/:id/ra-bills/:billId/reject` — `{ rejectionRemark }` (required).
  `submitted → draft`. Audit-logged.

---

## Work Orders — `/projects/:id/work-orders` (permission: `PROJECT_FINANCIALS`)

Write endpoints subject to `ProjectLockGuard`.

- `GET /projects/:id/work-orders` — list.
- `POST /projects/:id/work-orders` — `{ partnerId?, workDetail, terms?, requirements?,
  hireContract?, labourAmount, materialAmount }` → 201.
- `PATCH /projects/:id/work-orders/:woId` — update.
- `DELETE /projects/:id/work-orders/:woId` — draft/active only.

---

## Budget — `/projects/:id/budget` (permission: `PROJECT_FINANCIALS`)

Subject to `ProjectLockGuard`.

- `GET /projects/:id/budget` — `{ budgets: [{ category, amount }] }` (up to 5 rows).
- `PUT /projects/:id/budget` — `{ budgets: [{ category, amount }] }` — upserts all provided
  categories atomically. Categories: `labour` | `materials` | `machinery` | `fuel` |
  `subcontractors` | `overheads`. Missing categories unchanged.

---

## P&L — `/projects/:id/pnl` (permission: `PROJECT_FINANCIALS`)

- `GET /projects/:id/pnl?period=cumulative|monthly|quarterly|yearly&month=&quarter=&year=` —
  computes P&L on demand. Response shape: see data-model.md P&L Response Shape. Machinery/Fuel
  (006) and Labour (005) are real source calls; Materials (Inventory)/Subcontractors (Partners)
  are stubbed until those features ship, and `unavailableModules` is populated for those (not a
  500) rather than for the whole response.

---

## Project Documents — `/projects/:id/documents` (permission: `PROJECTS`)

Subject to `ProjectLockGuard`.

- `GET /projects/:id/documents` — list ordered by `documentType`.
- `POST /projects/:id/documents` — `multipart/form-data` with `documentType`, `file`,
  `filePath?`, `remark?` → 201. File stored as encrypted object-storage reference.
- `DELETE /projects/:id/documents/:docId` — removes record; schedules object-storage cleanup.
  `400` if `docId` not found.

---

## Audit logging

Every write to `Client`, `Project` (create/edit/lock/unlock), `Site`, `BOQTaskGroup`,
`BOQTaskItem`, `DWR` (approve), `Revenue`, `RABill` (state transitions), `WorkOrder`,
`ProjectBudget`, `ProjectDocument` writes an `AuditLogEntry` with `entityType`, `entityId`,
`actorUserId`, `action`, `before` (JSON), `after` (JSON), `timestamp`. Extends
`shared.AuditLogEntry.entityType` with: `PROJECT`, `CLIENT`, `SITE`, `BOQ_GROUP`, `BOQ_ITEM`,
`DWR`, `REVENUE`, `RA_BILL`, `WORK_ORDER`, `PROJECT_BUDGET`, `PROJECT_DOCUMENT`.
