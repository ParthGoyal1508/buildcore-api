# Contract: `/projects/dwr` endpoints (022)

Every endpoint requires `JwtAuthGuard` plus `@RequirePermission(Permission.DWR)` — the value 008
added and seeded into roles in August, which nothing has ever guarded because no route existed.
Every **write** additionally carries `ProjectLockGuard`.

No endpoint is public. A report belonging to another company is reported as **404, not 403**
(FR-029): a 403 confirms the row exists, which is itself a leak across a tenant boundary.

Quantities are `Decimal(18, 3)` and arrive as **strings**, as everywhere else in this API. Dates are
`YYYY-MM-DD`.

---

## Recording

### `POST /projects/:projectId/dwr` → 201

Creates a report in `draft` with its measurement lines.

```jsonc
{
  "workDate": "2026-01-15",
  "supervisorEmployeeId": "clx…",      // hr.Employee id, held bare
  "weather": "clear",                   // clear | rainy | overcast
  "workerCount": 14,
  "machineryCount": 6,
  "progress": 42,                       // the supervisor's own 0–100 assessment
  "location": "CH 228+200 RHS",         // optional
  "description": "…",                   // optional
  "contractFor": "self",                // optional
  "contractNumber": "16014256",         // optional
  "rfiNo": "…", "layer": "…",           // optional
  "lines": [ /* see the two shapes below */ ]
}
```

**A line has one of two shapes, discriminated by `paymentMode`** (FR-030a, FR-030b — research §3).
This is not a convenience: a presence-paid line **cannot carry the six factors at all**, so there is
no factor field for a later reader to mistake for a measurement.

```jsonc
// work_basis — measured work. The server computes the quantity.
{
  "paymentMode": "work_basis",
  "boqItemId": "clx…",                 // optional: freeform work is allowed (FR-007)
  "nos1": 1, "nos2": 1,
  "length": 12.5, "breadth": 3.75, "depth": 0.15, "density": 1,
  "chainageFrom": 228.2, "chainageTo": 228.45,
  "layer": "DBM", "roadSide": "RHS", "section": "…",
  "engineerName": "…", "remark": "…"
}

// day_basis — presence. The caller supplies the day served.
{
  "paymentMode": "day_basis",
  "boqItemId": "clx…",
  "servedQty": 0.5,                    // 1 = a full day
  "remark": "one paramedic absent",    // REQUIRED when servedQty < 1 (FR-030c)
  "equipmentId": "clx…",               // optional: the key FR-032 reads a logbook entry by
  "engineerName": "…"
}
```

**Response** carries `dprNumber`, generated from `Project.code` and a per-project sequence (FR-002 —
`Site` has no code field and the report has no site, so 008's `{siteCode}-{sequence}` was doubly
impossible; research §2). Any `quantity` the caller supplied for a `work_basis` line is **ignored**
and the computed one returned (FR-003, US1 AC4).

Each line comes back with `quantityInForce`, `exceedsScope`, and — where it applies — a note.

| Refusal | Code | When |
|---|---|---|
| 400 | `DWR_FACTOR_ZERO` | a factor supplied as 0, naming the factor (FR-004) |
| 400 | `DWR_FACTORS_ON_PRESENCE_LINE` | factors sent on a `day_basis` line (FR-030b) |
| 400 | `DWR_SHORT_DAY_NEEDS_REMARK` | `servedQty < 1` with no remark (FR-030c) |
| 400 | `DWR_WORK_DATE_IN_FUTURE` | a report describes a day that happened (FR-025) |
| 400 | `DWR_BOQ_ITEM_OTHER_PROJECT` | the BOQ line belongs to another project, naming both |
| 404 | — | the project is another company's (FR-029) |
| 423 | `PROJECT_LOCKED` | the project is locked (FR-008) — not 403; the same caller may write once it is unlocked |

**Accepted, with the fact reported rather than refused:**

- a work date before the project's start date → `warnings: ["DWR_WORK_DATE_BEFORE_PROJECT_START"]`
  (FR-025 — start dates are corrected after the fact more often than work is invented)
- a second report for a date already covered → 201, with `existingReports: [{ id, dprNumber }]`
  (US1 AC8 — two crews on two stretches is ordinary, and refusing the second loses it)
- a line past its BOQ line's scope → `exceedsScope: true` (FR-006 — the site did the work)

### `PATCH /projects/dwr/:dwrId` → 200

Partial update. Quantities recompute from the new factors (US3 AC1).

| Refusal | Code | When |
|---|---|---|
| 409 | `DWR_APPROVED_NOT_EDITABLE` | the report is approved — the message names the reversal path (FR-018) |

### `POST /projects/dwr/:dwrId/attachments` → 201 · `GET /projects/dwr/:dwrId/attachments/:ref`

Through the existing `StorageService`. The download carries the uploaded file name and a content
type detected from the bytes, via `detectContentType` / `describeStoredFile` /
`contentDispositionFor` — so a file arrives named rather than as a bare UUID (FR-009).

---

## Lifecycle

### `POST /projects/dwr/:dwrId/submit` → 200

`draft` → `submitted`. **No BOQ line's `doneQty` changes** (FR-011).

| Refusal | Code | When |
|---|---|---|
| 400 | `DWR_NO_LINES` | nothing to assert (FR-024) |
| 409 | `DWR_WRONG_STATUS` | not in `draft`, naming the status it is in |

### `POST /projects/dwr/:dwrId/approve` → 200

`submitted` → `approved`. Each measured BOQ line's `doneQty` increases by that line's
`quantityInForce` (FR-012). Approver and time recorded; one audit entry (FR-022).

All of a report's increments or none (FR-013); at most once however many times it is called
(FR-014); always a relative increment, never a value read earlier (FR-015).

| Refusal | Code | When |
|---|---|---|
| 409 | `DWR_WRONG_STATUS` | not `submitted` (FR-016) |
| 409 | `DWR_ALREADY_APPROVED` | already approved — and `doneQty` does not move twice (FR-014) |
| 403 | `DWR_APPROVER_IS_AUTHOR` | the approver submitted it (FR-012a, decision D2) |

### `POST /projects/dwr/:dwrId/return` → 200

`submitted` → `draft`. Nothing moves, because submission never moved anything (US3 AC2).

### `POST /projects/dwr/:dwrId/reverse` → 200

`approved` → `draft`, subtracting exactly what the approval added. `{ "reason": "…" }` is required.

```jsonc
{ "reason": "double-counted CH 228+200; measured twice by two crews" }
```

| Refusal | Code | When |
|---|---|---|
| 400 | `DWR_REVERSAL_NEEDS_REASON` | no reason given (FR-019) |
| 409 | `DWR_WRONG_STATUS` | not `approved` |
| 409 | `DWR_MEASUREMENT_BILLED` | reversing would drop a BOQ line's `doneQty` **below the quantity already billed against it** on a `submitted`/`certified` `ClientBill` or a `submitted`/`approved` `RABill`. The response names the bill. |
| 409 | `DWR_REVERSAL_BELOW_ZERO` | would drive a counter negative (FR-021) |

> **`DWR_MEASUREMENT_BILLED` is a floor, not provenance, and that is deliberate.** No column
> anywhere links a bill line to the measurement it consumed, so "has *this report* been billed" is
> not a question the database can answer. Research §4 states what 022 does instead, what is
> deferred to 023, and why adding the link now would be designing 023's composition model from
> inside 022.

### `DELETE /projects/dwr/:dwrId` → 204

Draft only (FR-023). A submitted or approved report is refused with `DWR_WRONG_STATUS`; an approved
one is reversed first.

---

## Reading

### `GET /projects/dwr?projectId=&from=&to=&status=&page=&pageSize=` → 200

Ordered by work date, server-paginated, with a `total` that does not depend on the page returned
(FR-026).

### `GET /projects/dwr/:dwrId` → 200

Each line beside its BOQ line's own position — `scopeQty`, `doneQty`, `pendingQty`, `targetQty`
(FR-027), reusing `BoqService`'s existing projection rather than recomputing it.

Where a line names an `equipmentId`, the equipment's logbook entry for the work date comes with it
(FR-032):

```jsonc
"logbook": {
  "date": "2026-01-15",
  "openingReading": "20935.000",
  "closingReading": "20939.000",
  "totalHours": "4.000",
  "remarks": "No Incident Battery Charging Round"
}
```

…or `"logbook": null` with `"logbookMissing": true` when the equipment has no entry for that date
(FR-033). **An absence is reported as an absence** — never as a run of zero — read through
`ProjectSourcesRegistry` and never by querying `plant.LogbookEntry` (research §5).

---

## The contract to feature 023

The read a bill defaults its claimed quantities from (FR-034 to FR-039). Specified here with its
own tests because 023 cannot start without it, and because a figure discovered as an implementation
detail of a bill is a figure nobody checks.

### `GET /projects/:projectId/dwr/period-figures?from=&to=` → 200

```jsonc
{
  "from": "2025-12-21",
  "to": "2026-01-20",
  "lines": [
    {
      "boqItemId": "clx…",
      "boqNo": "30.10",
      "taskName": "Providing of Manpower for O&M work …",
      "unit": "MON",
      "scopeQty": "12.000",
      "approvedInPeriod":  "0.700",   // by WORK DATE, not approval date (FR-036)
      "approvedBefore":    "1.900",
      "approvedUpToDate":  "2.600",   // the two, added
      "doneQty":           "2.600"    // the stored counter, for comparison
    }
  ]
}
```

Four properties, each of which needed deciding and each of which has a test:

1. **Only approved reports count**, and reversed ones not at all (FR-035).
2. **Attributed by work date**, never by approval date (FR-036) — a report for 21 December approved
   on 5 January belongs to December, or December's bill is short by it and January's claims work
   done before its period began. The client's own sheets carry both the month and the period for
   exactly this reason.
3. **Every BOQ line in the project is present, including lines with no approved measurement,
   carrying zeros** (FR-037) — so nothing composing a bill can drop a line by failing to find it.
4. **Consecutive non-overlapping ranges sum to the line's own `doneQty`** (US6 AC6). The same fact
   counted two ways; a discrepancy is reportable rather than silent.

| Refusal | Code | When |
|---|---|---|
| 400 | `DWR_RANGE_INVERTED` | `to` precedes `from` (FR-038) |

### `GET /projects/:projectId/dwr/reconciliation` → 200

FR-039. Per BOQ line, the difference between the stored `doneQty` and the sum of approved
measurement against it.

```jsonc
{ "lines": [ { "boqItemId": "clx…", "boqNo": "30.10",
               "doneQty": "2.600", "approvedSum": "2.600", "difference": "0.000" } ],
  "discrepancies": 0 }
```

### `POST /projects/:projectId/dwr/reconciliation/repair` → 200

FR-039c. Sets the stored counter to the authoritative sum for the lines named, as an **explicit
act**: `Permission.DWR`, a required reason, and an audit entry carrying the previous value.

```jsonc
{ "boqItemIds": ["clx…"], "reason": "drift of 5.000 traced to the 14 Jan partial failure" }
```

| Refusal | Code | When |
|---|---|---|
| 400 | `DWR_REPAIR_NEEDS_REASON` | no reason given |
| 409 | `DWR_NOTHING_TO_REPAIR` | the named lines have no discrepancy — refused rather than silently succeeding, so a caller learns the drift they were chasing is gone |

**There is deliberately no automatic repair.** A discrepancy is the only symptom of whatever moved
the counter without a report, and a system that silently corrects it destroys that evidence every
time, so the underlying fault is never found (decision D3).

`doneQty` **is** a denormalised counter — maintained by this feature's approvals and reversals, and
therefore capable of drifting through a partial failure, a hand-edit or a bug in reversal. This
endpoint is not a convenience beside it; it is the only thing that can say the counter is wrong. A
denormalised total with no way to check it is a total whose drift is discovered at a month-end
(research §6).
