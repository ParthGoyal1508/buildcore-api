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
| 23 | 100–150 concurrent at attendance peak, 50–60 normal | **Read path measured 2026-09-17**; punch path and cold start still unmeasured | NFR in 016, 018, 020 |
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

## Client bug review, 2026-09-16

The client re-stated the requirement list as `bugs.md`, to be worked in batches of four. The first
batch — company documents, attendance blocking and modification logging, project documents, project
search — mapped onto notes 1, 2, 3, 4 and 16, already specified in 016, 017, 020 and 021. The specs
were amended in place rather than restated in a new feature, and four decisions were taken:

| Decision | Effect |
|---|---|
| Required project documents are **per-kind mandatory or advisory**, configured by Super Admin from settings | **017 FR-007, FR-007b–d, FR-009** — reverses FR-009's guarantee that a project may always be created with documents outstanding, for mandatory kinds only |
| A punch failing location **or face** validation is **refused with nothing recorded** | **020 FR-012, FR-013, FR-013a–c, FR-015** — reverses FR-013's exception-for-review behaviour |
| 016's approval chain is **re-aimed at manual attendance corrections** | **016 US1, FR-012** — the refused punch no longer exists to review, so the correction is what enters the chain |
| Search matches **code and name** | **021 FR-001a–c, FR-003** |

Item 1 (company documents) needed no change: 017 FR-001–FR-006 and FR-023 already specify storage,
retrieval, the eight required kinds and permission-restricted access.

Two consequences are worth naming. First, 020's GPS-accuracy and face-confidence thresholds became
**blocking** clarifications on this date — under the old behaviour a wrongly refused punch still
reached a human, and under the new one it reaches nobody unless a supervisor notices. Second, 020's
hard refusal must not ship before 016's correction chain exists, or a refused punch has no recovery
route at all.

## Client bug review, 2026-09-29 — the remaining items

Items 5-23 were reviewed against every specification and, where the specification was silent, against
the code. The first finding is that **the list is almost entirely already specified**: bugs.md is a
re-statement of the same 26 notes, so the mapping below is mostly the mapping above read through the
client's new numbering. Three items were genuinely short, and three cannot be closed by writing a
specification at all.

### bugs.md item → where it lives

| bugs.md | Item | Spec | Verdict 2026-09-29 |
|---|---|---|---|
| 1 | Company document management | 017 FR-001–006, FR-023 | Covered (2026-09-16) |
| 2 | Attendance blocking + modification log | 020 FR-012–013d, 016 FR-012a–e | Covered (2026-09-16) |
| 3 | Project document management | 017 FR-007–009e | Covered (2026-09-16) |
| 4 | Project search | 021 FR-001–004 | Covered (2026-09-16) |
| 5 | Multi-company root selector | 019 FR-008–013 | Covered |
| 6 | Payroll automation | 016 FR-013–017 | Covered, **blocked on role mapping** |
| 7 | Director approval for all final actions | 016 FR-018–018c | **Amended** — closed set kept, made visible and guarded |
| 8 | Salary slip email | 021 FR-005–009 | Covered |
| 9 | Advance salary settlement | 021 FR-010–013 | Covered |
| 10 | Full & final settlement + **asset tracking** | 021 FR-014–014e, FR-018a–b | **Amended** — assets were absent entirely |
| 11 | Project BOQ & billing | **008 US4** (entry, shipped) + 018 FR-001–014 | Covered |
| 12 | Subcontractor billing | 018 FR-006–009, FR-016a | Covered |
| 13 | Fuel & machinery deductions | 020 FR-001–010 | Covered; one open marker (recovery cap) |
| 14 | Project labour & expense summary | 018 FR-010–011a | **Amended** — monthly roll-up and export |
| 15 | Geo-fencing | 020 FR-011–016 | Covered (2026-09-16) |
| 16 | Cash visibility toggle | 019 FR-014–017 | Covered |
| 17 | Project & labour ID, auto wage | **Already built** (013) | Covered — verified in code |
| 18 | Letter template system | 017 FR-010–019 | Covered — FR-010 names 15 kinds to the client's 13 |
| 19 | Sub-module permissions | 019 FR-001–007 | Covered |
| 20 | 100-150 concurrent users | NFRs in 016, 018, 019, 020 | Read path measured; **punch path and cold start open** |
| 21 | Approval & action tracking | 016 FR-002, FR-008–011 | Covered |
| 22 | Mobile compatibility | Web NFRs | **Blocked — contradicts a NON-NEGOTIABLE principle** |
| 23 | Payment transfer attachments | 017 FR-020–021 | Covered |

### The three amendments

| Item | What was missing | Decision |
|---|---|---|
| 10 | The word "asset" did not appear in 021 at all. FR-014's "recoverable kit" is the inventory issue register; `assets.AssetAllocation`, which records the custodian, the site and the expected return date, was never reached. An employee could clear exit holding a company laptop. | An open allocation **blocks** final settlement on the same terms as kit, waivable under FR-016 with an author and reason, and every asset held appears on the settlement summary whether or not it blocked. Value is **not** recovered — no valuation rule exists to recover it by. |
| 14 | Two narrow gaps, not the whole item. Feature 013's `LabourPaymentSheet` already *is* a per-project per-worker wage register, and 018 FR-010/FR-013 already give the monthly labour cost reconciled to it. What was missing: the sheet's period is a *wage period*, not a calendar month, so a fortnightly cycle has no monthly per-worker view; and nothing let the monthly position leave the screen. | 018 FR-010a/b add the calendar-month roll-up across sheets, stating how a straddling sheet was apportioned, derived and never recomputing a wage. FR-011a adds the export. |
| 7 | 016 FR-018 names four director-final action types; the client has now twice asked for all of them. FR-018a also claimed "the client confirmed these four", which the re-statement contradicts. And the configurability was unguarded — whoever could edit the set could remove payment release from it and then release a payment. | The closed configurable set **stays** (a literal reading halts daily work and cannot be tested, since nothing defines "critical"). What changes: the wording now says the four are this product's proposal, not the client's answer; FR-018b makes editing the set itself director-final; FR-018c requires the full set to be reportable, and web 016 US4 puts it on a screen the client can read and amend. |

### The three that a specification cannot close

- **Item 6 — "Site Incharge" and "HR Office" do not exist among the nine roles.** 016 FR-016 restricts
  attendance edits during a payroll review to HR; naming the wrong role either locks out the people
  doing the work or grants the right to people who should not have it. **Blocking for FR-016 and US2's
  chain.** This has been outstanding since 2026-09-13.
- **Item 20 — measured in part only.** The read path sustains 170-190 rps (below). The punch path
  costs an unmeasured amount of CPU per request and the cold start has never been reproduced. 020
  NFR-001 is the open one.
- **Item 22 — contradicts buildcore-web Principle VI, which is NON-NEGOTIABLE.** Recorded in both
  016 specifications on 2026-09-29 and deliberately **left for a separate decision**: widening the
  mobile-critical list is a MAJOR constitution bump affecting every web feature shipped and unshipped,
  and no feature specification may amend a constitution. Note that v2.1.0 already moved every
  non-critical screen's breakage floor to 320px — that may already be what the client means by "fully
  functional", and asking them is cheaper than a constitutional amendment.

### Two claims corrected while checking

Both were mine, and both would have produced work that was not needed:

- **Item 11 does not need a BOQ entry requirement.** "Allow detailed BOQ entry per project" is feature
  008 User Story 4, shipped, including validated Excel import. 018 begins where entry ends.
- **Item 14 was very nearly complete, not half missing.** The first read treated the per-project
  labour summary as absent. `LabourPaymentSheet` and `PaymentSheetLine` carry days worked, the resolved
  rate, gross, deductions and net per worker per project. Only the calendar-month framing and the
  export were short, and the amendment is correspondingly small.

Item 17's third bullet — *"Use AI to auto-calculate wages for daily workers (male/female) based on
pre-set rates per project"* — was checked in code rather than assumed. `MusterService` resolves the
rate through `WageRateService` on every muster line, `WageRate` is per project, skill category and
effective date, and male and female rates are two `SkillCategory` rows. Nothing about this needs a
model; the word "AI" describes automation that exists.

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
numbers, and until 2026-09-17 every one of them said it was unverified.

**Note 23, measured in part on 2026-09-17.** A read-only ramp against the production free-tier
instance (0.1 shared CPU) sustained **170–190 requests per second** with zero errors, zero timeouts
and zero non-2xx responses at up to 150 concurrent connections, degrading by queueing rather than
failing and returning to baseline immediately. The full table is under 016 NFR-001.

The result **inverts the expected conclusion**: request volume is not the constraint. 150 employees
punching within a 15-minute window is 0.17 requests per second averaged, 2.5 per second in a
one-minute burst, against a ceiling of 170. The concurrency numbers the client asked for are
comfortably within free-tier reach *for requests of that weight*.

What the measurement does not cover is the weight of a real attendance action. The route tested
touches no database; a punch decodes and resizes an image, runs face matching on the WASM/CPU
backend, encrypts a blob and writes rows. That is CPU-bound, and 0.1 shared CPU is exactly where
CPU-bound work fails — so the risk has moved from "can it take the traffic" to "what does one punch
cost", which is 020 NFR-001 and is still open.

**The cold-start claim previously asserted here is withdrawn as unverified.** This document stated
that a suspended instance's first request "has been observed taking tens of seconds". The instance
was already awake when tested, so that figure was neither confirmed nor reproduced, and it should
not be repeated as fact until it is. What remains true and unmeasured: the free tier suspends after
roughly 15 minutes idle, and no cold start can meet a 2-second target whatever its exact length —
which lands on whoever punches first each morning. That part is an infrastructure decision, not a
development task.

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
