# Feature Specification: Labour Worker Edit, Site Transfer, and Contractor on Payment Sheets

**Feature Branch**: `052-labour-worker-edit`
**Created**: 2026-10-31
**Status**: Implemented

**Input**: The client is about to load about 380 labour workers, many with only a name. There is no way to edit a worker: the only fix is to deactivate and register again, which issues a new labour code. Workers also move between sites, and nothing supports that. The user also said: "we can still create the payment sheet on the site basis and can pay in the cash. Also when we are downloading the sheet, we need to show the contractor name as well." The user asked for the feature to be built in full, with no clarification rounds, and for decisions to be recorded here.

## What exploring the codebase found

- **Routes today** (`src/labour/workers/`): list, detail, register (`POST /labour/workers`), deactivate, face enrolment. All are under `DAILY_WORKER_REGISTRY`. Site Incharge and Labour Supervisor roles hold that permission. `LABOUR_APPROVE` (the HR office) sets site rates and approves sheets, and lifts the supervisor-site restriction.
- **Attendance belongs to the site it was punched at.** `LabourPunch.siteId`, `MusterRoll.siteId` and the face-punch musters built from them all carry the site. A punch is refused unless `worker.siteId` equals the punch's site. The attendance grid already keys days by `worker|site`. A payment sheet reads the approved musters **of its site**. So changing `worker.siteId` alone already sends future days to the new site and leaves past days at the old one.
- **What payment sheets snapshot**: each `PaymentSheetLine` stores `daysWorked`, `overtimeHours`, `resolvedRate`, `rateSource`, `grossWage`, deductions and net. Gender, special rate and engagement type are read **live** from the worker when a sheet is generated or a draft regenerated. An approved sheet is frozen. The contractor was not stored on the line at all; the download did not show it.
- **Engagement type decides which sheet a worker is on** (direct = cash with denominations, contractor = separate sheet). The overlap guard is per engagement type, so a worker whose engagement changes could have the same day priced on a direct and a contractor sheet.
- **Corrections for a day with no punch** go to `worker.siteId`, which after a move would be the wrong site for a day before it.
- **Gangs** belong to a site.
- **Aadhaar** is a plain column, masked to the last 4 in responses, unique among active workers (409). The audit log records `changes` as JSON.
- **Contractor names** come from `partners` through `LabourRefsService.contractorNames`. A supervisor may not hold `PARTNERS`, so the web has no vendor list it can read.

## Requirements

### A. Edit a worker

- **FR-001** `PATCH /labour/workers/:id` edits `fullName`, `gender`, `fatherName`, `phone`, `dateOfBirth`, `aadhaarNumber`, `bankAccount`, `skillCategoryId`, `engagementType`, `contractorId` and `rateOverride`. An omitted field is unchanged. `null` clears an optional field. Name, gender and engagement can be changed but not cleared. Unknown fields (including `siteId`) are refused with 400.
- **FR-002** Validation matches registration. The phone must match the mobile pattern. A contractor-engaged worker needs a contractor (`400 LABOUR_CONTRACTOR_REQUIRED`), and a **newly named** contractor must be an active vendor of the worker's company. A skill must exist. An Aadhaar held by another active worker is refused with `409 LABOUR_AADHAAR_EXISTS` (with `existingWorkerId`). Making a worker direct clears the contractor.
- **FR-003** The labour code, site and face template are kept.
- **FR-004** Setting, changing or clearing `rateOverride` needs `LABOUR_APPROVE` (`403 LABOUR_RATE_NEEDS_APPROVE`), at registration as well as on edit. Everything else needs `DAILY_WORKER_REGISTRY` and, for a supervisor, a worker at an assigned site.
- **FR-005** The edit is audited as `LABOUR_WORKER / UPDATE` with `changes: { fields: [...] }`, which lists the **names** of the changed fields only, never their values. An edit that changes nothing writes nothing.
- **FR-006** The detail response adds `dateOfBirth`, `contractorName` and the site history (`transfers`). The list adds `contractorName`.
- **FR-007** `GET /labour/workers/contractor-options` lists the company's active vendors (`id`, `name`, `type`), labour contractors first, under `DAILY_WORKER_REGISTRY`, for the contractor picker.

### What an edit does to recorded data

- **FR-008** Punches, corrections and musters carry no worker detail, so an edit does not touch them.
- **FR-009** A generated payment sheet line keeps its rate, days, gross and net. It now also keeps the **contractor** it was priced under (`PaymentSheetLine.contractorId`). An edit reaches a sheet only when that sheet is generated, or a draft regenerated, **after** the edit, and then for the sheet's whole period. Approved sheets are frozen and never change.
- **FR-010** When an engagement change puts a worker on both kinds of sheet, a day already on a live sheet of the other engagement type at the same site is left off the new sheet, so no day is paid twice.

### B. Transfer to another site

- **FR-011** `POST /labour/workers/:id/transfer { siteId, reason? }` moves an active worker to another site. The caller must be able to work at both sites. The move is refused for an inactive worker (`400 LABOUR_TRANSFER_WORKER_INACTIVE`), the same site (`400 LABOUR_TRANSFER_SAME_SITE`), a site that does not exist or belongs to another company (`400 LABOUR_TRANSFER_SITE_NOT_FOUND`), an inactive site (`400 LABOUR_TRANSFER_SITE_INACTIVE`), or while the worker is punched in and not yet out (`409 LABOUR_TRANSFER_ON_SITE`).
- **FR-012** The move takes effect **today** (company time zone). It is kept in `labour.LabourWorkerTransfer` (from, to, day, reason, who, when), and the worker's active gang membership is ended.
- **FR-013** Days punched before the move stay with the old site's musters and payment sheets, and days from the move on go to the new site. A correction that adds a day with no punch goes to the site the worker was at **on that date**.
- **FR-014** The face template moves with the worker. Supervisors see the worker at the new site only.
- **FR-015** Audited as `LABOUR_WORKER / UPDATE` with `fields: ['siteId']` and the two site ids.

### C. Contractor on the payment sheet

- **FR-016** The payment sheet download (`GET /labour/sheets/payment/:id`) gains a **Contractor** column after Gender: the vendor name, blank for direct labour. The totals row and the money columns' number format move one column right. Nothing else in the layout changes.
- **FR-017** The payment sheet detail (`GET /labour/payment-sheets/:id`) lines gain `contractorId` and `contractorName`. A line priced before 052 has no contractor of its own, so on a contractor sheet the worker's current contractor stands in for it.
- **FR-018** Sheets stay per site, and direct labour is still paid in cash with the denomination breakup. Nothing about generation changes except FR-009 and FR-010.

### D. Web

- **FR-019** The Labour list shows the contractor, and each row has **Edit** and, for active workers when the caller works at more than one site, **Transfer**. To fit the two new actions without sideways scrolling, father's name and mobile move under the name, and status, face photos and NOC stack in one Status column. Row actions wrap in the shared list (on phone cards they used to run off the screen).
- **FR-020** The edit form holds every field. Aadhaar and bank account show the masked value; typing replaces it, and "Remove" clears it. Special rate shows only to callers holding `LABOUR_APPROVE`. Contractor is a picker from `contractor-options`, shown only when engagement is Contractor.
- **FR-021** Registration (the field screen) gains engagement, contractor, skill, Aadhaar, bank account and, for `LABOUR_APPROVE` holders, special rate, under a collapsible "More details" section so the gate flow stays short.
- **FR-022** The Transfer dialog picks a site from the caller's sites (the current one excluded), takes an optional reason, and says what happens to past days.
- **FR-023** The payment sheet screen shows the contractor beside each worker.
- **FR-024** Everything works at phone width.

## Clarifications (decision log)

### Session 2026-10-31 — decided by implementer; the user asked for no clarification rounds

- Q: What permission does editing a worker need? → A: `DAILY_WORKER_REGISTRY`, the same as registration, at a site the caller works at. **The special daily rate needs `LABOUR_APPROVE`**, on edit **and at registration**. (decided by implementer, 2026-10-31. The special rate overrides the site rate the HR office sets with `LABOUR_APPROVE`. Site Incharge and Labour Supervisor hold only `DAILY_WORKER_REGISTRY`, so without this a site supervisor could raise their own workers' pay. Registration is included because otherwise "deactivate and register again" would get around the rule. Nothing in the API, web or tests sent a rate at registration.)
- Q: How do edits affect payment sheets already generated? → A: **They don't.** A line keeps the rate, days, gross and contractor it was priced with. The edit applies to sheets generated, or drafts regenerated, after it, **for that sheet's whole period**, because neither the gender nor the special rate has an effective date. (decided by implementer, 2026-10-31. Lines already snapshot the money. The contractor was added to the snapshot so a later contractor change cannot relabel an old sheet. Dating rate and gender would mean a history table and per-day pricing for a rare case. The practical rule for the office is: **fix a worker's gender, special rate or engagement before generating the sheet for the days you want it to apply to; to apply it to a draft, regenerate the draft. An approved sheet must be reopened to pick it up.**)
- Q: A gender change moves the worker to the other site rate. From when? → A: The same rule. From the next generation or regeneration, for that sheet's whole period. (decided by implementer, 2026-10-31. Most gender edits will fix data entered wrongly at the gate, where applying it to unpaid days is the right result.)
- Q: An engagement change (direct ↔ contractor) after a sheet covers some days? → A: Allowed. A new sheet of the other type leaves off days the worker already has on a live sheet of the first type at that site (FR-010). (decided by implementer, 2026-10-31. The overlap guard is per engagement type, so without this a day could be paid in cash and through the contractor. A draft of the old type keeps the worker until it is regenerated, and then the worker drops off.)
- Q: Re-check an existing contractor that has since gone inactive? → A: No. Only a newly named contractor is checked. (decided by implementer, 2026-10-31. A vendor made inactive should not stop somebody correcting the worker's mobile number.)
- Q: Can an inactive worker be edited? → A: Yes. (decided by implementer, 2026-10-31. Correcting a name or father's name on a worker who has left still matters for the sheets that print them. The Aadhaar rule only considers active workers, as registration does.)
- Q: Should Aadhaar or bank values appear in the audit log? → A: No. Field names only, per Principle IV. (decided by implementer, 2026-10-31)
- Q: A separate transfer endpoint, or `siteId` on the PATCH? → A: A separate `POST /labour/workers/:id/transfer`. `PATCH` refuses `siteId`. (decided by implementer, 2026-10-31. A move has consequences (history, gang, supervisor visibility) that an edit should not have by accident.)
- Q: Should a transfer take an effective date? → A: No. It takes effect today. (decided by implementer, 2026-10-31. Attendance already belongs to the site it was punched at, so there is nothing to re-assign. A backdated date would not move any punch, and a future date would leave a worker who cannot punch anywhere in the meantime. The day is stored, and a correction for a day with no punches uses it to pick the site.)
- Q: Whose sites must the caller hold? → A: Both the current site and the target. The HR office (`LABOUR_APPROVE`) holds every site. (decided by implementer, 2026-10-31. A supervisor should not be able to place labour on another supervisor's roll, or take labour from one.)
- Q: What if the worker is on site at the moment? → A: Refused while their latest punch is an "in" from today or yesterday (a night shift). (decided by implementer, 2026-10-31. A day that started at one site and ended at another would split across two musters.)
- Q: Gangs? → A: The active membership is ended, as deactivation does. (decided by implementer, 2026-10-31. Gangs belong to a site.)
- Q: Face enrolment? → A: Unchanged. The template belongs to the worker. (decided by implementer, 2026-10-31)
- Q: Which payment sheet download gets the contractor, and where? → A: The labour payment sheet workbook, as a **Contractor** column right after Gender, on direct and contractor sheets alike (blank for direct labour). The monthly attendance sheet already has a "Contractor / Gang" column. (decided by implementer, 2026-10-31. The client's `docs/Payment_Docs` samples cover staff salary, not labour, so the column goes beside the other identity columns, before the figures, which keeps the totals row lined up.)
- Q: The user's "we can still create the payment sheet on the site basis and can pay in the cash" — does this change sheet generation? → A: No. Sheets are already per site, and direct sheets are cash with denominations. Only the contractor column is added. (decided by implementer, 2026-10-31. Putting contractor labour on the cash sheet would be a separate decision about how contractor labour is paid. It is not taken here.)
- Q: Where does the contractor picker get its list? → A: A new `GET /labour/workers/contractor-options` under `DAILY_WORKER_REGISTRY`: active vendors of the company, labour contractors first, then subcontractors, then the rest. (decided by implementer, 2026-10-31. Supervisors do not hold `PARTNERS`. Registration accepts any active vendor, so the picker does not hide vendors of another type.)
- Q: The list gained two row actions and no longer fit at 1366 px. → A: Father's name and mobile now sit under the name, status, face and NOC are stacked in one column, and the shared `ResponsiveList` lets row actions wrap. (decided by implementer, 2026-10-31, after the visual check. The wrap also fixes phone cards, where five buttons pushed Edit off the left edge.)
- Q: Registration form length on a phone? → A: The new fields sit under a collapsed "More details" section. (decided by implementer, 2026-10-31. At the gate, name, gender and photos are what matter. The office fills the rest from the edit form.)

## API

All under `DAILY_WORKER_REGISTRY` with JWT. A supervisor is limited to workers at their assigned sites.

| Method | Path | Body | Response |
|---|---|---|---|
| `PATCH` | `/labour/workers/:id` | any of `fullName`, `gender` (`male`/`female`), `fatherName`, `phone`, `dateOfBirth` (`YYYY-MM-DD`), `skillCategoryId`, `engagementType` (`direct`/`contractor`), `contractorId`, `aadhaarNumber`, `bankAccount`, `rateOverride` (number > 0, 2 dp; `LABOUR_APPROVE`). `null` clears an optional field. | 200, worker detail |
| `POST` | `/labour/workers/:id/transfer` | `{ siteId: string, reason?: string }` | 201, worker detail with `transfers` |
| `GET` | `/labour/workers/contractor-options` | `?companyId=` for a cross-company caller | `[{ id, name, type }]` |

Worker detail: the list item (`id, labourCode, fullName, fatherName, gender, phone, skillCategoryId, engagementType, contractorId, contractorName, siteId, status, aadhaarNumber (masked), bankAccount (masked), faceEnrolled`) plus `rateOverride`, `dateOfBirth` and `transfers: [{ fromSiteId, toSiteId, transferredOn, reason }]`.

## Data

- `labour.LabourWorkerTransfer` (new): `companyId`, `workerId` → `LabourWorker` (cascade), `fromSiteId`, `toSiteId`, `transferredOn` (date), `reason?`, `createdBy`, `createdAt`. Tenant RLS policy.
- `labour.PaymentSheetLine.contractorId` (new, nullable).
- Migration `20261031100000_labour_worker_transfer`. It is additive and has no backfill.

## Success criteria

- A worker registered with a name only can have every other detail filled in later, under the same labour code.
- A payment sheet generated before an edit prints and shows the same figures and contractor after it.
- A transferred worker's earlier days are paid on the old site's sheet and their later days on the new site's.
- The downloaded payment sheet names each worker's contractor.
