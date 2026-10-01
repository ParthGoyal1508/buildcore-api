# Contracts: Access Granularity and Multi-Company

**Date**: 2026-09-29. Interface contracts this feature adds or changes. buildcore-web's
`019-access-and-multi-company` consumes these; it is unplanned and this document is what it plans
against.

## Existing endpoints: what changes

### Every guarded endpoint — a new refusal shape

No route is added, removed or renamed. What changes is that a caller holding an area at `read` and
attempting a write is now refused where previously it succeeded.

```
403 Forbidden
{
  "statusCode": 403,
  "code": "PERMISSION_LEVEL_INSUFFICIENT",
  "message": "This action requires write access to Machinery. You have read access.",
  "required": { "permission": "MACHINERY", "level": "write" },
  "held": { "permission": "MACHINERY", "level": "read" }
}
```

`code` is machine-readable so the interface can distinguish it from "you hold nothing here":

| `code` | Meaning | What the interface should do |
|---|---|---|
| `PERMISSION_LEVEL_INSUFFICIENT` | Area held, level too low | Hide the control (FR-004). Seeing this at all is a bug in the interface, not in the guard |
| `PERMISSION_AREA_DENIED` | Area not held | Refuse navigation to the module entirely (FR-005) |

The distinction is deliberate: FR-004 requires controls be hidden rather than disabled, so an interface
that is behaving correctly should never provoke `PERMISSION_LEVEL_INSUFFICIENT`. Making it a distinct
code means "we are showing a button we should not" is detectable rather than indistinguishable from an
ordinary denial.

### `GET /auth/me` — the caller's grants gain levels

The effective-permission list becomes area-and-level pairs. **Breaking shape change** for any client
reading `permissions` as a flat array of strings.

```
{
  "id": "...",
  "permissions": [
    { "permission": "LOGBOOK",  "level": "write" },
    { "permission": "LOGBOOK",  "level": "read"  },
    { "permission": "FUEL",     "level": "write" },
    { "permission": "FUEL",     "level": "read"  },
    { "permission": "MACHINERY","level": "read"  }
  ],
  "companies": [
    { "id": "...", "name": "Tirupati Enterprises", "selected": true },
    { "id": "...", "name": "Parth Realcon Pvt. Ltd.", "selected": false }
  ],
  "hideCashTransactions": false
}
```

Three things travel together here on purpose. The interface needs all three to render a screen — what
it may do, which company it is doing it in, and whether cash is hidden — and fetching them separately
means a first paint that is wrong in one of the three.

`companies` carries exactly the companies this user may access. A user with one company gets an array
of one, which is how the interface satisfies FR-013 without a second call to ask whether to offer a
switcher.

### Role management — the payload gains a level

`POST /settings/roles` and `PATCH /settings/roles/:id`:

```
{
  "name": "Site Operator",
  "permissions": [
    { "permission": "LOGBOOK", "level": "read"  },
    { "permission": "LOGBOOK", "level": "write" },
    { "permission": "FUEL",    "level": "read"  },
    { "permission": "FUEL",    "level": "write" },
    { "permission": "MACHINERY","level": "read" }
  ]
}
```

Validated per element; an unknown `permission` or `level` is a 400 naming which element failed.

**Write without read is refused at definition time**, 422 `WRITE_WITHOUT_READ`, naming the areas. The
spec's edge case asks whether this is coherent; it is not — a role that may change records it cannot
see can neither find what to change nor see what it changed. Refusing at definition is the cheap place
to say so. This is a decision the spec left open and the plan closes; it is recorded in the spec's
Clarifications if the client disagrees.

## New endpoints

### `GET /settings/companies/selectable`

The companies the caller may work in. Present for every caller, one element for most.

```
200 [ { "id": "...", "name": "Tirupati Enterprises", "selected": true } ]
```

### `PUT /my/company-selection`

FR-008, FR-010, FR-011.

```
{ "companyId": "..." }
```

| Response | When |
|---|---|
| `200` with the selection | Accepted |
| `403 COMPANY_NOT_ACCESSIBLE` | The caller may not access that company. **Not 404** — a 404 would tell a caller which company ids exist |
| `400` | Malformed id |

The selection takes effect for **subsequent** requests. It does not retroactively rescope a request in
flight, and the interface must discard cached views on success (FR-012) — the response carries no data
to make that automatic, deliberately, because a response that re-sent everything would be a second
source of truth for every list on screen.

### `GET /settings/permission-refusals`

FR-003's record, readable under `USER_MANAGEMENT` at `read`.

```
200 {
  "items": [
    {
      "id": "...", "userId": "...", "userName": "...",
      "method": "POST", "path": "/plant/machinery",
      "requiredPermission": "MACHINERY", "requiredLevel": "write",
      "heldLevel": "read",
      "createdAt": "2026-09-29T09:14:00.000Z"
    }
  ],
  "total": 1
}
```

Filterable by `userId`, `requiredPermission` and date range. `path` is the route template, never the
resolved URL — a resolved URL carries record ids, and a security log that accumulates them becomes a
PII store nobody classified as one.

### `PATCH /settings/company-settings/cash-visibility`

FR-014, FR-016. Requires `COMPANY_SETTINGS` at `write`.

```
{ "hideCashTransactions": true }
```

Every change is written to the audit log with actor and time. `403` for a caller without the
permission, which is FR-016's "restrict who can change it".

## Cash hiding: how a response changes

FR-015 requires consistency across screens, reports and exports. With `hideCashTransactions` true, the
amount is **absent and explicitly marked**, not zeroed:

```
{ "id": "...", "paymentMode": "cash", "amount": null, "amountHidden": true }
```

`amount: null` with `amountHidden: true` rather than `amount: 0`. A zero is a figure, and a reader —
or a spreadsheet summing a column — cannot tell a hidden amount from a real zero. `amountHidden` is
what lets the interface render "hidden" instead of blank, and what stops an export from silently
understating a total by the value of every cash payment in it.

Exports follow the same rule: the column is present and marked, not dropped. Dropping it would change
the shape of a file somebody's spreadsheet depends on.
