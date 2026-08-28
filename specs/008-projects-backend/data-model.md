# Data Model: Projects Backend (Portfolio, Clients, Sites, BOQ, DWR, Revenue, P&L)

Field names are conceptual; exact Prisma types are a task-level decision. All tables live in the
`projects` schema. See research.md for schema placement rationale and cross-module decisions.

## Client (`projects` schema — new)

```
{ id, companyId, name, contactPerson, phone, email, address, gstin (unique per company, optional),
  status: 'active' | 'inactive', createdAt, updatedAt }
```

UNIQUE constraint: `(companyId, gstin)` where gstin is non-null.

## Project (`projects` schema — new)

```
{ id, companyId, code (unique per company), name, clientId FK→Client, location,
  contractValue (decimal), startDate, expectedEndDate, status: 'planning' | 'ongoing' | 'on_hold'
  | 'completed', projectManagerEmployeeId (FK reference to hr.Employee — resolved via HR exported
  service for reads; stored as plain UUID, not a Prisma relation across schemas),
  division: 'contract' | 'own', departmentType (string), projectType (string),
  siteType: 'site' | 'toll' | 'plant', isHO (boolean, default false),
  isLocked (boolean, default false), siteStartDate?, purchaseLimit (decimal?), orderNumber?,
  cgstApplicable (boolean, default false), description (text?), createdAt, updatedAt }
```

UNIQUE constraint: `(companyId, code)`.

## Site (`projects` schema — REPLACES 003's minimal `hr.Site`)

```
{ id, companyId, projectId FK→Project (nullable for backward compat with existing rows),
  name, address?, latitude (decimal?), longitude (decimal?),
  geofenceRadius (integer?, meters), status: 'active' | 'inactive', createdAt, updatedAt }
```

Unchanged from 003: `id`, `name`, `companyId`. New columns are nullable, added via additive
migration. HR's `PunchRecord` retains its `siteId` FK — no foreign key change needed since the
table still exists with the same primary key.

## BOQTaskGroup (`projects` schema — new)

```
{ id, companyId, projectId FK→Project, boqNo (string), name, startDate, finishDate,
  scopeQty (decimal), isEstimate (boolean, default false), createdAt, updatedAt }
```

## BOQTaskItem (`projects` schema — new)

```
{ id, companyId, groupId FK→BOQTaskGroup, boqNo (string), taskName, unit (string),
  scopeQty (decimal), startDate, finishDate, duration (integer, days), perDayQty (decimal),
  doneQty (decimal, default 0 — running total updated on DWR submission/reversal),
  isEstimate (boolean, default false), createdAt, updatedAt }
```

Derived (computed on read, not stored):
- `pendingQty = scopeQty − doneQty`
- `avgQtyPerDay` = doneQty / elapsed working days since startDate (0 if no elapsed days)
- `daysToComplete` = pendingQty / avgQtyPerDay (null if avgQtyPerDay = 0)

## DailyWorkReport (`projects` schema — new)

```
{ id, companyId, projectId FK→Project, workDate (date), dprNumber (string, unique per company),
  supervisorEmployeeId (UUID, cross-schema reference — stored as plain UUID),
  weather: 'clear' | 'rainy' | 'overcast',
  status: 'draft' | 'submitted' | 'approved',
  workerCount (integer, default 0), machineryCount (integer, default 0),
  progress (integer 0–100), location (string?), description (text?),
  contractFor: 'self' | 'contract', contractNumber?,
  rfiNo?, layer?,
  approvedByUserId (UUID?), approvedAt?,
  fileRefs (string[], object-storage references for attachments),
  createdAt, updatedAt }
```

UNIQUE constraint: `(companyId, dprNumber)`.

## DWRTask (`projects` schema — new)

```
{ id, dwrId FK→DailyWorkReport, boqItemId FK→BOQTaskItem (nullable — task can be freeform),
  layer (string?), chainageFrom (decimal?), chainageTo (decimal?), roadSide (string?),
  paymentMode: 'work_basis' | 'day_basis',
  nos1 (decimal, default 1), nos2 (decimal, default 1),
  length (decimal, default 1), breadth (decimal, default 1),
  depth (decimal, default 1), density (decimal, default 1),
  actualQty (decimal — server-computed: nos1 × nos2 × length × breadth × depth × density),
  exceedsScope (boolean, default false),
  engineerName (string?), remark (text?),
  layerNo (string?), section (string?) }
```

## Revenue (`projects` schema — new)

```
{ id, companyId, projectId FK→Project, description, amount (decimal),
  date (date), status: 'received' | 'pending', createdAt, updatedAt }
```

## RABill (`projects` schema — new)

```
{ id, companyId, projectId FK→Project, billNumber (string), description (text?),
  amount (decimal), billingDate (date),
  status: 'draft' | 'submitted' | 'approved',
  submittedAt?, approvedByUserId (UUID?), approvedAt?,
  rejectionRemark (string?), createdAt, updatedAt }
```

State machine (research.md §7): `draft → submitted → approved`; `submitted → draft` via reject
(mandatory `rejectionRemark`). Approved bills are immutable.

## WorkOrder (`projects` schema — new)

```
{ id, companyId, projectId FK→Project,
  partnerId (UUID?, cross-schema reference to partners module — stored as plain UUID),
  workDetail (text), terms (text?), requirements (text?), hireContract (text?),
  labourAmount (decimal, default 0), materialAmount (decimal, default 0),
  status: 'draft' | 'active' | 'completed',
  createdAt, updatedAt }
```

## ProjectBudget (`projects` schema — new)

```
{ id, companyId, projectId FK→Project,
  category: 'labour' | 'materials' | 'machinery' | 'fuel' | 'subcontractors' | 'overheads',
  amount (decimal), updatedAt }
```

UNIQUE constraint: `(projectId, category)`. Upserted via `PUT /projects/:id/budget`. Up to 5 rows
per project (one per category).

## ProjectDocument (`projects` schema — new)

```
{ id, companyId, projectId FK→Project,
  documentType (string — e.g. 'address_details' | 'tax_details' | 'gst' | 'other'),
  fileRef (encrypted object-storage reference, same pattern as hr.EmployeeDocument),
  filePath (string?), remark (string?),
  uploadedByUserId (UUID), uploadedAt }
```

## Cross-module references

| Reference | Stored as | Resolved via |
|---|---|---|
| `Project.projectManagerEmployeeId` | Plain UUID in `projects` schema | `HrService.getEmployeeById()` on reads that need name/designation |
| `DailyWorkReport.supervisorEmployeeId` | Plain UUID | Same |
| `Site` (replacing `hr.Site`) | Table moved to `projects` | `ProjectsService.getSiteById()` called by `hr` module |
| `WorkOrder.partnerId` | Plain UUID | `PartnersService.getPartnerById()` when needed |
| P&L labour cost | Not stored | `HrPayrollService.getLabourCostByProject()` at request time |
| P&L material cost | Not stored | `InventoryService.getMaterialCostByProject()` at request time |
| P&L machinery cost | Not stored | `PlantService.getMachineryCostByProject()` at request time |
| P&L fuel cost | Not stored | `PlantService.getFuelCostByProject()` at request time |
| P&L subcontractor cost | Not stored | `PartnersService.getSubcontractorCostByProject()` at request time |

## P&L Response Shape (not stored — computed on demand)

```typescript
interface ProjectPnlResponse {
  contractValue: number;
  revenueBooked: number;      // sum of approved RABills + received Revenue entries
  costBreakdown: Array<{
    category: PnlCategory;     // 'labour'|'materials'|'machinery'|'fuel'|'subcontractors'|'overheads'
    budget: number;            // from ProjectBudget, 0 if not set
    actual: number;            // from cross-module service (0 if unavailable)
    variance: number;          // budget − actual
    variancePct: number;       // variance / budget × 100 (null if budget = 0)
    costOverrunAlert: boolean; // actual > budget × 1.10
  }>;
  grossProfit: number;        // revenueBooked − sum(all 6 actual costs)
  marginPct: number;          // grossProfit / revenueBooked × 100 (null if revenueBooked = 0)
  period: 'monthly' | 'quarterly' | 'yearly' | 'cumulative';
  unavailableModules: string[];
}
```
