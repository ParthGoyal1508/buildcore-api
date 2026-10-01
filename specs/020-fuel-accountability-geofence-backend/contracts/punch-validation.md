# Contract: Punch Validation and Refusal (020, User Story 3)

Scope: User Story 3 only. The fuel half's service surface is contracted when `bugs.md` item 13
reaches its batch.

---

## Part 1 — the changed function

```ts
/**
 * Whether a punch falls inside a fence, allowing for the fix's own imprecision.
 *
 * `accuracyMeters` is OPTIONAL and `?? 0` is load-bearing: a client that does not
 * send it gets exactly the pre-2026-09-16 verdict, so adding the parameter cannot
 * regress any client shipped today (plan D21).
 */
export function checkGeofence(
  punch: { latitude: number; longitude: number; accuracyMeters?: number },
  site: { latitude: number; longitude: number; geofenceRadiusMeters: number },
): { withinGeofence: boolean; distanceMeters: number };
```

The boundary stays **inclusive**, for the reason already written into the function: making the verdict
at the fence edge depend on floating-point rounding is not a defensible way to decide whether someone
gets paid for a shift.

**The unlocatable check runs before this function, not inside it.** Exceeding the company's maximum is
a refusal in its own right, and folding it in here would let a very poor fix be refused as unlocatable
on a small fence and admitted by its own imprecision on a large one — the allowance rewarding exactly
what the maximum rejects.

---

## Part 2 — service methods across module boundaries

```ts
/** `PunchRefusalsService` (hr) */

/** Write the log row. Called from the refusal path, never from the accepted path. */
record(ctx: RlsContext, input: PunchRefusalInput): Promise<void>;

/** The caller's OWN refusals for a month (FR-013b's after-the-fact companion). */
mine(ctx: RlsContext, employeeId: string, month: number, year: number):
  Promise<PunchRefusalView[]>;

/** For the operational and security read (FR-013c). Permission-gated, never open to
 *  everyone who can see attendance — this holds location and failed-verification
 *  facts about a named person. */
forCompany(ctx: RlsContext, companyId: string, query: PunchRefusalQuery):
  Promise<Paged<PunchRefusalView>>;
```

```ts
/** `EmployeeLocationAssignmentsService` (hr) */

/** The assignment in force for a given DAY, not a given moment (research §5).
 *  Returns null when the employee has none — the caller then falls back to the
 *  site fence, which is FR-016. */
inForceOn(ctx: RlsContext, employeeId: string, day: string):
  Promise<{ siteId: string | null; isMobile: boolean } | null>;

/** FR-011. Records author and effective date; never mutates a prior row. */
assign(ctx: RlsContext, input: AssignLocationInput): Promise<void>;
```

`CompaniesService` gains `getPunchAccuracyMaxMetres(companyId): Promise<number>` — resolving the
company setting against the configured default, so no caller ever has to know the fallback exists. It
is read in the same method that already calls `getPayrollLockDay`, adding no new cross-module reach.

---

## Part 3 — HTTP surface

| Method | Path | Guard | Notes |
|---|---|---|---|
| `POST` | `/my/punch` | own | **Changed**: `SubmitPunchDto` gains `accuracyMeters?`. Refuses with 422 instead of recording an exception |
| `GET` | `/my/punch/refusals` | own | The caller's own refusals. FR-013b is satisfied at the moment of refusal; this is the companion for "what happened last Tuesday" |
| `GET` | `/attendance/refusals` | attendance audit | FR-013c's operational read. Filters by employee, day range and reason |
| `GET` | `/employees/:id/location-assignments` | `EMPLOYEES` | FR-011's history |
| `PUT` | `/employees/:id/location-assignment` | `EMPLOYEES` | Assign or exempt. Appends, never overwrites |
| `PUT` | `/settings/company/punch-accuracy` | `COMPANY_SETTINGS` | FR-012b. Super Admin holds this by definition |

### The refused response

`422 Unprocessable Entity`. Not 400 — the request is well-formed. Not 403 — the caller is entitled to
punch. Not 409 — the day's recorded state is irrelevant to the refusal.

```jsonc
{
  "statusCode": 422,
  "code": "PUNCH_REFUSED_LOCATION",   // stable, branchable
  "message": "…",                      // human, shown to the employee
  "distanceMeters": 412,               // present for location refusals
  "fenceRadiusMeters": 100
}
```

| Code | Raised when |
|---|---|
| `PUNCH_REFUSED_LOCATION` | Locatable, and outside the fence once the accuracy allowance is applied |
| `PUNCH_REFUSED_UNLOCATABLE` | Reported accuracy exceeds the company's configured maximum |
| `PUNCH_REFUSED_FACE` | Face mismatch **or** no detectable face — the advice is the same, retake the photo |

`PUNCH_REFUSED_UNLOCATABLE` is separate from `PUNCH_REFUSED_LOCATION` because the two call for
different actions from the person holding the phone, and collapsing them would tell a worker standing
in the right place to move.

---

## What this contract deliberately does not include

- **Any route that resolves, approves or overturns a refusal.** FR-013c forbids it. The route back to
  a paid day is feature 016's manual attendance correction, and it is reached from the attendance
  surface, not from here.
- **A refusal photo.** Plan D20, research §4.
- **A per-site accuracy threshold.** The obvious next request (research §3 says so), and not what the
  client asked for. The company-level setting is shaped so a site override can be layered later
  without moving it.
- **Anything in the fuel half.** `bugs.md` item 13, a later batch.
