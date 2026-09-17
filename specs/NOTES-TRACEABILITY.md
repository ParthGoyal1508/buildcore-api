# Client Notes → Specification Traceability

**Source**: client requirements spreadsheet, "Note:" section — 26 numbered requirements.
**Audited against**: buildcore-api and buildcore-web, 2026-09-13.

Every note is accounted for below. A note is only marked *Already satisfied* where the working code
was identified; everything else became a requirement in one of specs 016–021.

| # | Note (abbreviated) | Status before this audit | Spec |
|---|---|---|---|
| 1 | Company KYC with PDF attachments | Numbers stored on Company; **no document store at all** | 017 US1 |
| 2 | Attendance exception approval cycle Employer→HR→Director | Single-step `resolve` only | 016 US1 |
| 3 | New-project required documents (LOI, WO, insurance, mining, labour insurance, BOQ) | `ProjectDocument` exists, no required set | 017 US2 |
| 4 | Search by project/vendor/vehicle/employee code on dashboard | **Nothing** — no search anywhere | 021 US1 |
| 5 | Show who approved/rejected, beside the item | Central activity log only, nothing per-record | 016 US3 |
| 6 | Action & Review control on every work item | **Nothing** | 016 US4 |
| 7 | Payroll auto-run on the 1st; Site Incharge→HR→Director; only HR edits attendance | No payroll cron; states are draft/processed/paid | 016 US2 |
| 8 | Director approval as final authority | Per-module `_APPROVE` values only; no final tier | 016 US5 |
| 9 | Email salary slip on payment; upload transaction sheet | Email infrastructure exists, not wired to slips | 021 US2 |
| 10 | Advance settlement reflected in the Bank Payment Sheet | Bank sheet exists; late-advance recovery unconfirmed | 021 US3 |
| 11 | Full & Final: document return, ID closure | `ExitRecord` + F&F run exist; no clearance gate | 021 US4 |
| 12 | Client billing linked to BOQ; reconciliation for P&L and budget | `Revenue` is description/amount/date/status — **untethered from BOQ** | 018 US1, US3 |
| 13 | Subcontractor billing as a BOQ measurement sheet | `RABill` is a flat amount | 018 US2 |
| 14 | Fuel benchmark → alert → deduct from hire bill and operator salary | **Detection already built** (`fuelBenchmark`, `variancePercent`, `varianceAlert`); no consequence | 020 US1, US2 |
| 15 | Per-project monthly labour and expense summary vs client billing | Payment sheets and budget exist; no roll-up | 018 US3 |
| 16 | Geofencing mandatory, fixed per employee | Geofence is per **Site** only | 020 US3 |
| 17 | Toggle to hide all cash transactions | **Nothing** | 019 US3 |
| 18 | Project ID for office + supervisor ID for daily labour; fixed M/F wages | **Already satisfied** — `/labour/muster`, `DAILY_WORKER_REGISTRY`, `WageRate`, `SkillCategory` | — |
| 19 | 13 letter kinds, fixed terms, digital signature, signed copy back | 5 HR kinds only; no signature | 017 US3, US4 |
| 20 | Create new letter templates without a developer | Templates exist but bounded by a 5-value enum | 017 US5 |
| 21 | Letter menus in Recruitment and in Project Details | Recruitment only | 017 US6 |
| 22 | Part-level permissions within a module (logbook entry only) | Module-level only; **no read/write split** | 019 US1 |
| 23 | 100–150 concurrent at attendance peak, 50–60 normal | **Never measured** | NFR in 016, 018, 020 |
| 24 | Two companies with a switcher at the top | Data layer ready (`CROSS_COMPANY_ACCESS`); **no switcher UI** | 019 US2 |
| 25 | Admin site usable on Android and iPhone | Only `/my/*` held to a mobile standard | NFR in 016, 017, 019, 021 |
| 26 | RTGS / payment-transfer proof attachment | `Payment.referenceNumber` only, no attachment | 017 US7 |
| 27 | *(blank in the source sheet)* | — | — |

## Where the specs live

Each theme is a pair, following the convention of 001-015:

| Theme | buildcore-api | buildcore-web |
|---|---|---|
| Approval spine | `016-approval-spine-backend` | `016-approval-spine` |
| Documents and letters | `017-documents-and-letters-backend` | `017-documents-and-letters` |
| BOQ, billing, P&L | `018-boq-billing-pl-backend` | `018-boq-billing-pl` |
| Access, multi-company | `019-access-and-multi-company-backend` | `019-access-and-multi-company` |
| Fuel, geofence | `020-fuel-accountability-geofence-backend` | `020-fuel-accountability-geofence` |
| Search, payout, exit | `021-search-payout-and-exit-backend` | `021-search-payout-and-exit` |

## Settled by the client

**Director is the Super Admin role** (2026-09-13). Recorded in `016-approval-spine-backend`, along
with the consequence: Super Admin holds every permission in the system, including
`USER_MANAGEMENT`, `COMPANY_SETTINGS` and `DATA_DELETE`. Making it the final approval authority
means the person who releases payroll can also change who approves payroll. Worth revisiting;
not blocking.

**"HR Office" and "Site Incharge" are still unmapped.** Neither exists among the nine roles. The
first of them gates FR-016 — the rule that only HR may edit attendance during a payroll review — so
naming the wrong role either locks out the people doing the work or hands the right to people who
should not have it.

## Two things worth saying plainly

**Note 14 is half done, and the built half is the harder half.** The system already detects fuel
overconsumption per machine. What it does not do is act on it. The specification reflects that:
020 adds consequences and explicitly leaves detection alone.

**Notes 23 and 25 cannot be closed by writing code.** They are written as testable NFRs with real
numbers, and every one of them says it is unverified. Note 23 in particular is at risk from the
current hosting: the production API runs on an instance class that suspends when idle, and a
suspended instance's first request has been observed taking tens of seconds — which alone breaches
the target, before any load is applied. That is an infrastructure decision, not a development task.

**Note 25 additionally contradicts a NON-NEGOTIABLE constitutional principle.** buildcore-web's
Principle VI defines mobile-critical surfaces as a closed list — punch, attendance viewing, leave —
and every other screen as desktop-first. That list was narrowed to exactly that in a MAJOR version
bump, on the explicit finding that mobile-first was "wrong about most of the product". Note 25 asks
to reverse it. No feature specification can amend a constitution, so the six web specs each state
where they sit against Principle VI and leave the decision recorded in `016-approval-spine`. It must
be settled before any of them is planned.

## What is not covered

The spreadsheet's module rows (sections 1–7, above the Notes) list the intended feature surface.
Those were **not** audited here — the request was specifically the Notes section. Several module
rows imply capability beyond these six specs (for example "Total Group Dashboard" detail, DPR
material management, spare parts inventory depth). A separate pass over the module rows would be
needed to claim full coverage of the sheet.
