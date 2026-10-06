# Contract Delta: Projects Flow Completion

**This document is a delta.** It specifies only what feature 025 adds or changes. Everything else
in the projects module is unchanged and documented by features 008, 018, 022 and 023.

**Read this before writing a client.** The defect that prompted this feature was a client module
written against a guessed shape while a contract document sat unread in the repository. Every field
below is stated as it crosses the wire.

---

## 1. NEW - Plan a schedule line

```
PATCH /projects/:projectId/boq/items/:itemId
```

**Permission**: `PROJECTS`. **Guard**: `ProjectLockGuard` - a locked project answers **423**, never
403, because the same person may write the moment it is unlocked.

**Request** - every field optional; all four are the programme, and nothing else is accepted:

| Field | Type | Meaning |
|---|---|---|
| `startDate` | ISO date string, or `null` | Omit to leave unchanged. `null` clears it. |
| `finishDate` | ISO date string, or `null` | Omit to leave unchanged. `null` clears it. |
| `duration` | integer >= 1, or `null` | Planned working days. |
| `perDayQty` | decimal string >= 0, or `null` | Overrides the derived needed rate. |

**Omission and clearing are different.** A field not present is untouched; a field present as `null`
returns to unplanned. Any other field - `scopeQty`, `rate`, `unit`, `taskName`, `boqNo` - is
**refused with 400**, not ignored: the global pipe runs at `forbidNonWhitelisted`. Planning is when
the work happens; those fields are what the work is.

**Response 200**: the updated line in the same shape the BOQ read returns, so a client can replace
the row in place:

```jsonc
{
  "id": "…", "boqNo": "1", "taskName": "…", "unit": "Cum",
  "scopeQty": "825.729", "rate": "251.00", "doneQty": "0.000", "pendingQty": "825.729",
  "perDayQty": "20.000",        // null where unplanned
  "avgQtyPerDay": "12.500",     // null until startDate is set AND work is recorded
  "daysToComplete": 41,         // null where no achieved rate exists
  "startDate": "2026-10-01T00:00:00.000Z",
  "finishDate": "2026-12-31T00:00:00.000Z",
  "isVariation": false, "isEstimate": false,
  "state": "onTrack"            // unplanned | onTrack | today | toBeDelayed | delayed
}
```

**Refusals**:

| Status | Code | When |
|---|---|---|
| 400 | `boq_programme_inconsistent` | The merged programme contradicts itself - a finish date before the start date. Checked against the **stored row overlaid with the request**, so a PATCH carrying only a finish date is still caught. |
| 400 | (validation) | An unknown field, a duration below 1, a negative per-day quantity, an unparseable date. |
| 404 | - | No such line, **or** a line belonging to another company. Never 403: a 403 would confirm the row exists. |
| 423 | - | The project is locked. |

---

## 2. CHANGED - The daily work report list grows two fields

```
GET /projects/dwr
```

Each item in `items` gains:

| Field | Type | Why |
|---|---|---|
| `createdByUserId` | string, nullable | 022 FR-012a - the author of a report may not approve it. Without this a client cannot show the rule before the action is attempted. |
| `submittedByUserId` | string, nullable | Same rule: approval is checked against whoever put the report forward. |

**Additive and backward compatible.** Nothing is removed or renamed. The item shape is otherwise
exactly as feature 022 published it:

```jsonc
{
  "items": [{
    "id": "…", "dprNumber": "PRPL-2401-0001",
    "workDate": "2026-10-05T00:00:00.000Z",
    "status": "draft",            // draft | submitted | approved | returned
    "workerCount": 3, "machineryCount": 4, "progress": 0,
    "lineCount": 2,               // a COUNT. The lines themselves are on the detail read.
    "createdByUserId": "…", "submittedByUserId": null
  }],
  "total": 1, "page": 1, "pageSize": 20
}
```

**The three things a client must not assume about this response**, each of which was assumed by a
client and each of which produced the defect this feature repairs:

1. The identifier is **`dprNumber`**. There is no `reportNumber` in this system.
2. There is **no lines array**. `lineCount` is the count, and it is all a list page carries.
3. The creation response is **not** this shape - see below.

---

## 3. RESTATED - What recording a day returns

```
POST /projects/:projectId/dwr   ->  201
```

Unchanged by this feature, and restated because a client demanded three fields it never sends:

```jsonc
{
  "id": "…",
  "dprNumber": "PRPL-2401-0001",
  "status": "draft",
  "warnings": [
    { "code": "work_date_before_project_start", "message": "…", "detail": { "startDate": "…" } }
  ]
}
```

**No `projectId`. No `workDate`. No lines.** A client that requires them rejects every successful
save - which is precisely what happened: the server recorded the day, returned 201, and the screen
showed a parse error, so the day was recorded and believed lost.

**`warnings` is an array of objects**, never of strings. Each carries a machine-readable `code`, a
sentence written for the person reading it, and whatever `detail` that person needs to act. The
three warnings are a work date before the project started, a second report for a date already
covered, and a line past its BOQ scope. **All three accompany a success**; none is a failure.

---

## 4. NEW - The statutory rates

```
GET  /settings/companies/:id/billing-rates
PATCH /settings/companies/:id/billing-rates
```

**Permission**: the settings permission that already governs company configuration.

```jsonc
{
  "cgstFraction": "0.090000",
  "sgstFraction": "0.090000",
  "igstFraction": "0.180000",
  "tdsFraction":  "0.020000",
  "bocwCessRate": "0.0100"      // read-only here; it has its own existing surface
}
```

Each rate is a **fraction**, bounded `[0, 1]`, to six decimal places. `0.09` is nine per cent; `9`
is refused. Every change is audited under `AuditEntityType.COMPANY`.

**Changing a rate does not move an issued bill.** A package freezes its rates at issue precisely so
that a document already sent reproduces identically; this endpoint affects what is composed after
it, and nothing else.

---

## 5. CHANGED - The project carries its client retention term

```
POST  /projects
PATCH /projects/:id
```

Both gain one optional field:

| Field | Type | Range | Meaning |
|---|---|---|---|
| `clientRetentionFraction` | number | 0 to 1, six decimal places | The client contract's retention term **as a fraction**. `0.05` is 5%. |

**A fraction, not a percentage - deliberately.** `WorkOrder.retentionPercent` is already a fraction
with the same bound, and `resolveRates()` reads both terms four lines apart in the same function.
Two units in one function is how a 5% term becomes a 500% deduction. A screen collecting a
percentage divides by 100 before sending, exactly as the subcontract bill sheet already does.

**Absent remains a refusal, not a zero.** Composing a client-direction package without this term
answers 400 with `rate_missing` and `missingRate: "retentionFraction"`, and says why: billing at
zero retention makes the payable five per cent too high and nothing downstream would notice.
