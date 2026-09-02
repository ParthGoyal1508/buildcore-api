# Module 5 — HR & Payroll: what's left

**Written**: 2026-09-02
**Covers**: `buildcore-api/specs/005-hr-payroll-backend` and `buildcore-web/specs/005-hr-payroll`
**Note**: this file is a copy — the same document lives at
`buildcore-web/specs/005-hr-payroll/REMAINING.md`. Edit both, or delete one.
**Branch**: `feature/hr-payroll` in both repos
**Last commits**: api `23bf8f3`, web `2ecf59b`

---

## The short version

The module is **functionally complete and shippable for the paths that have been
built**. What remains is, in order of how much it matters:

1. **Nothing has been verified in a browser or against a live server.** Lint,
   typecheck and build pass in both repos; 368 backend unit tests pass. None of
   that proves a screen works.
2. **Zero e2e tests exist for this module** — ~40 are specced. The harness is
   there and working; nobody has written the file.
3. **A few small, concrete gaps** (`.env.example`, one exported service method).
4. **Deliberate omissions** that need no action unless a decision changes.

Nothing below is blocking a demo of the employee → attendance → leave loop.

---

## 1. Verification — nothing has been run against a live system

This is the largest real gap and the cheapest to close.

**Backend** (`T120`, `T121`, `T122`) and **frontend** (`T069`, `T070`, `T071`).

- `quickstart.md` exists in both repos and has never been executed end to end.
- No screen has been opened in a browser. Every route compiles and every route
  builds; that is all that is known.
- Specifically unverified on the frontend:
  - **Keyboard operability** (`T069`). It was built in per-component — the tab
    strips implement the ARIA pattern with arrow keys, `DataTable`'s scroll
    container is focusable, every control is a native element — but "built in"
    is not "checked".
  - **PII never visible without an explicit reveal** (`T070`). The backend
    strips the encrypted columns on every read path and `MaskedField` only ever
    holds the masked value, so this should hold by construction. Confirm it.
  - **Unbroken at 768px, no horizontally-scrolling page body**. `DataTable` owns
    the overflow, so this is structural — but it is the new constitution v2.0.0
    rule and has never been looked at.
- Specifically unverified on the backend:
  - **RLS coverage on every new `companyId`-scoped table** (`T121`). Worth real
    attention: the migrations are written and the transfer-aware policy was
    reasoned through carefully, but the local Postgres role cannot verify RLS
    enforcement — `npm test` prints `RlsPreflight: permission denied` on every
    run. **That warning means the safety net you think you have is unconfirmed.**
  - **PII encrypted at rest** (`T122`).

### Seed data will get in the way

Checked on 2026-09-02 against the local database:

| Username | Employee | Data |
|---|---|---|
| `admin` | DEMO-0001 | 10 punch records — the only attendance data |
| `sampleuser1` | DEMO-0003 | 2 leave applications, 3 leave balances |
| `sampleuser2` / `sampleuser3` | DEMO-0004/5 | leave balances only |
| `user` | DEMO-0002 | nothing |

The other 10 accounts (`abc`, `abc2`, `direct1-3`, `frontend.test4878`, four
`E2E*`) have **no employee record**, so `/my/*` 403s for them and they appear
nowhere in the HR screens.

Also: **0 payroll runs, 1 site, 3 companies**, and no employee has `basic`/`hra`
populated. So payroll, challans, register, TDS and Form 16 will all render empty
states, and a run generated today would compute to zero. **Seed salary structure
on at least one employee before verifying anything downstream of payroll** —
otherwise those five screens cannot be meaningfully checked at all.

---

## 2. E2E tests — ~40 specced, 0 written

Earlier notes in this project claimed no harness existed. **That was wrong.**
`test/jest-e2e.json` and four working spec files are in the repo
(`app`, `settings`, `account-creation`, `my-workspace`). Run with `npm run test:e2e`.

So this is not blocked on infrastructure — it is unwritten work. Follow
`test/my-workspace.e2e-spec.ts`; it is the closest analogue and already sets up
an authenticated, company-scoped caller.

Backend tasks: `T017-T019`, `T027-T028`, `T035-T038`, `T044`, `T046-T049`,
`T058-T059`, `T062-T063`, `T068`, `T088`, `T097-T099`, `T104-T106`, `T111-T113`,
`TA012`, `TA016-TA017`, `TA022`.

**The five worth writing first**, because they cover logic that is easy to get
wrong and expensive to get wrong late:

- `T047` — a processed run's figures are immutable.
- `T036` — an attendance edit inside a payroll-locked period is rejected (423).
- `T068` — transfer with and without code retention, and that pre-transfer
  attendance stays with the original company. This is the transfer-aware RLS
  policy; it is the subtlest thing in the module.
- `TA022` — register / deduction report / challan three-way reconciliation.
- `T099` — F&F computation (already has unit coverage of the pure function;
  this is the wiring).

Note `T118` (lint + build) is effectively done — both pass — but is left
unchecked in `tasks.md` because it should be re-run at the end, not once.

---

## 3. Small concrete gaps

**`.env.example` is missing six variables** (backend `T124`). Verified missing
on 2026-09-02:

```
TDS_NO_PAN_RATE
TDS_PROOF_CUTOFF_MONTH
TDS_CEILING_80C          (and 80D, 80CCD1B, HRA)
TDS_STANDARD_DEDUCTION
SALARY_ADVANCE_LIMIT_MULTIPLE
REPEAT_LATE_COMER_THRESHOLD
```

All have working defaults in `src/common/configs/config.ts`, so nothing breaks
without them — but a deployment that needs to override a statutory ceiling has
no way to discover the variable exists. **~10 minutes.**

Note the frontend duplicates the ceilings in `TDS_SECTION_CEILINGS`
(`app/lib/constants.ts`) for the "allowed amount" display. They are display-only,
so a mismatch misinforms rather than miscalculates — but if you override
`TDS_CEILING_*` in an environment, update both.

**`T057a` — `getLabourCostByProject()` is not implemented.** An exported service
method summing `netPay` across `PayrollLineItem`s by `projectId` and period
range, for feature 008's P&L to call. Nothing in module 5 uses it; it exists
purely as 008's dependency. Build it when 008 starts, not before — the shape
should be driven by its actual caller.

**Backend `T119` (Swagger decorators) is done** despite being unchecked — every
controller under `src/hr/` and `src/payroll/` has `@ApiTags`. Verified
2026-09-02. Safe to tick.

---

## 4. Two stop-gap endpoints that feature 008 must replace

Both were added during frontend work because the frontend was otherwise
unbuildable. Both are deliberately minimal and **should be replaced, not
extended**:

- **`GET /projects/sites`** (`src/projects/sites/sites.controller.ts`).
  `Employee.siteId` is mandatory on create and nothing enumerated sites, so the
  Add Employee form was literally unfillable. Returns `{id, name}` only.
  Feature 008 owns Site administration.
- **`GET /hr/attendance/employee/:employeeId?month&year`**. The Employee Detail
  attendance calendar had no admin route.
  `AttendanceHistoryService.getMonthForEmployee` already existed and was already
  used internally, but the only HTTP route to it is `/my/punch/history`, which
  takes no employee parameter by design (FR-028) and so cannot serve an admin
  viewing somebody else. This one is legitimately part of the HR admin surface
  and can stay.

---

## 5. Deliberate omissions — no action needed

**User Story 9, Daily Worker Registry** — omitted in *both* repos.
Superseded by feature **013 (Labour Management)**, whose Supervisor Muster
Capture covers the same persona and the same job. Backend `T079-T087` and
`T072-T078`, frontend `T045-T049`. `DailyWorker` was never implemented, so 013's
migration task `T004` is also unnecessary — **a saving that only holds while 005
US9 stays unbuilt.** If US9 is ever revived, 013 needs that migration back.

**Frontend `T003`/`T004`** — promoting `camera-capture.tsx` and the geolocation
helper to shared. Their only second consumer was US9. Marked not-needed rather
than done; revisit only if US9 returns.

**Frontend `T068`** — superseded by constitution v2.0.0. It tested the old
blanket mobile-first rule. Replaced by the 768px check in section 1.

**`TA028-TA030`** — blocked on features 011 and 012:
- `TA028`: read 011's accepted Resignation for last-working-day and notice period.
- `TA029`: call 011's letter service for the relieving letter.
- `TA030`: surface outstanding asset custody at exit via 012's
  `getOutstandingCustody()`.

Today the exit flow takes the last working day as manual input, which works and
is not wrong — it just duplicates something 011 will own.

---

## 6. Known unfixed analysis findings

Carried from the gap-closure analyze pass, neither in module 5's own scope:

- **Backend F1** — 008 FR-008's source list.
- **Backend F2** — 004's department dashboard methods.
- **Frontend F1** — use `recharts` (pre-approved in the constitution) rather than
  the Principle II inline-style exception, wherever a chart lands.
- **Frontend F2** — dependency governance for drag-and-drop / virtualisation, if
  011's pipeline board needs either.

---

## 7. Where things stand

**Frontend — 15 routes, all building:**

```
/dashboard/hr                        section grid, permission-filtered
/dashboard/hr/employees              list, /new, /[id], /[id]/edit
/dashboard/hr/attendance             register · holidays · late-coming · import
/dashboard/hr/leave                  applications · balances
/dashboard/hr/payroll                runs, /[id] → lines · register · deductions
/dashboard/hr/challans               PF · ESIC · PT · TDS
/dashboard/hr/tds                    slabs · declarations · quarterly · Form 16
/dashboard/hr/loans
/dashboard/hr/advances
/dashboard/hr/reimbursements
/dashboard/hr/re-enrolment
```

Transfer and offboarding/F&F are dialogs on the employee detail page.

**Two decisions worth not re-litigating:**

- **`DataTable`, not `ResponsiveList`.** Constitution v2.0.0 makes these desktop
  surfaces and explicitly permits a horizontally-scrolling table in its own
  container. The salary register is read *across* the row; stacking eighteen
  columns into label/value pairs destroys the comparison the screen exists for.
  The overflow lives on the container, so the page body still never scrolls
  sideways.
- **PII inputs are not prefilled on the edit form.** The API only ever returns
  masked values, so seeding the input would write `XXXXXXXX1234` back as the
  value on the next save. Blank means "leave unchanged". Do not "fix" this.

---

## Suggested pickup order

1. Seed a salary structure on one employee, then run `quickstart.md` in both
   repos. This is the highest-value hour available and will surface more than
   any amount of further reading.
2. Fix whatever that turns up.
3. `.env.example` (10 min), tick `T119`.
4. The five e2e tests named in section 2.
5. Resolve the RLS preflight warning so `T121` can actually be verified.
