# 036: UX / QA hardening fix plan

**Source:** [audit.md](audit.md). Item IDs (A1, F3, O1…) refer to that audit.

**Branches:** `036-ux-qa-hardening` in both repos, cut from `004-dashboard-backend` (api) and `004-dashboard` (web).

**Status:** all decisions made (section 4). Ready to start Wave 0 on your go-ahead. No code changes yet.

---

## 1. Parallel agents or one at a time? Both, in waves

Neither approach on its own is right. Which one fits depends on whether the work touches the same files.

| Work type | Why | Approach |
|---|---|---|
| **Shared frontend kit:** `client.ts`, `button.tsx`, `modal.tsx`, `responsive-list.tsx`, `format.ts`, pickers, upload component | Almost every screen imports these. Parallel agents editing them would conflict on every merge, and every module fix depends on them. | **One agent at a time**, built first |
| **Backend money and data fixes** in separate modules (payroll, labour, billing, inventory/plant) | Separate folders, separate tests, little shared code. Each needs careful work plus regression tests. | **Parallel**, one agent per module, each in its own worktree and database |
| **Per-module screen fixes** after the kit exists | Each module's screens live in their own folders, and they just use the kit. | **Parallel**, one agent per module working across both repos for that module |
| **Design-system clean-up and accessibility pass** (raw buttons, colour tokens, contrast) | Touches hundreds of files across every module. | **One agent, last**, after everything else has merged |

**Rules for parallel work.** These follow the project's existing worktree and database practice.

- **Isolation:**
  - Each agent works in its own git worktree, on a sub-branch named `036-<stream>`, cut from `036-ux-qa-hardening`.
  - Each agent uses its own database, `buildcore_036_<stream>`, passed explicitly as `POSTGRES_DB=…` on every prisma and jest command. The shared `buildcore` database is never touched.
- **Migrations:**
  - Only the streams listed below may add migrations.
  - When I merge a stream, I check the migration timestamps are in order.
- **Done means:**
  - New or updated unit tests for every bug fixed.
  - An e2e test on the stream's own database for every server-side rule.
  - `tsc` and lint pass.
  - One commit per audit item (or a small group), with the item IDs in the message.
- **Review:**
  - I review each stream's diff and re-run its tests before merging it into `036-ux-qa-hardening`.
  - You review at the end of each wave.
  - Nothing is pushed until you say so.
- **Scale:** at most 5 agents at a time, so merges and your reviews stay manageable.

---

## 2. Waves

### Wave 0: groundwork (one at a time, me), done on 17-10-2026

**Where Wave 0 differed from this plan:**
- **B1:** the guard went on `InvitesController` only, not global. The throttler's default limit is the sign-in limit (10 a minute), so a global guard would have capped every route at that. The app-wide limit stays in 1e (B9), as a separate, generous limit.
- **E2E database:** `test/README-e2e.md` already prescribes `buildcore_scratch`. Instead of a new config, a first setup file (`test/refuse-shared-database.ts`) now refuses to start when `DATABASE_URL` is unset, is an unexpanded template, or names `buildcore`.
- **A19:** also added `businessDate(instant)`, so timestamp-vs-today comparisons (interviews) use IST on both sides. Stored-date *display* (`toISOString` on stored values) is left for the A18 formatter in Wave 2.
- **A6:** a full scan found 6 read-only buttons missing `intent="read"`: the 5 in the audit plus "Open onboarding".

**Results:**
- API: `tsc` clean; 222/222 unit suites and 2,506 tests pass.
- Web: `npm run typecheck` clean; lint shows the 11 known warnings (down from 57,914).

These are small changes to files every later stream touches, so they go in first.

- **Tooling:**
  - **A31:** add `.claude/**` to the ESLint ignores, and run typegen before `tsc`.
  - **E2E database:** add a separate e2e test database config, so e2e tests never touch `buildcore`.
- **Shared one-liners:**
  - **A25:** add `.catch()` to the session refresh promise.
  - **A30:** move theme settings to `viewport`.
  - **A19:** IST-aware `todayIso()` and `currentPeriod()`, replacing all 34 `toISOString().slice(0,10)` calls.
  - **A6:** read-intent buttons.
- **Backend one-liners:**
  - **B1:** global `ThrottlerGuard`.
  - **B12:** fix the boolean query transform in 5 DTOs.
  - **B10:** move the Prisma exception filter into `configureApp`, so tests and production behave the same.

### Wave 1: backend money, data and security (5 agents in parallel, api)

These go first because they corrupt money or data today.

| Stream | Items | Migration? |
|---|---|---|
| **1a payroll** | F1, F2 (undo or settle recoveries at Process); F3 (store `advanceRecovered`); F4, F5, F6 (paid needs approval, plus a race-safe status change); F7 (save exceptions); the F8 server totals; F11 (bank sheet becomes POST plus month filter); F19 maker-checker; G1 (punch time) | Yes: `PayrollLineItem.advanceRecovered`, `PayrollRun.exceptions` |
| **1b labour** | O1 (reserve advance deductions); O2 (delete or regenerate draft sheets; reopen recomputes); O3 (`periodTo < today`, punch checks the sheet, generate lock); O4 (carry-forward, payment cap, muster approval guard); O5 (overnight shifts); O14; labour advance self-approval | Maybe: reserved amount on advances, plus an exclusion constraint on sheet periods |
| **1c projects billing** | I1, I2 (lock guard resolves dwr/package to project and is mounted on RA bills, client bills and work orders); I3, I4 (award ceiling at submit, row locks); I5 (Decimal rounding, GST state-code warning); I19, I20 server side; I24 radius maximum; I26 caps | No |
| **1d inventory, plant, assets** | M1, M2, M3, M4, M6, M8 self-approval, M10 idempotency, M14; K1–K5, K8, K10 (validation only, no GPS), K11, K17, K18; L1 | Maybe: unique constraint on payment reference, plus slip and transfer number uniques |
| **1e platform security** | B2, B3 (selected company everywhere); B17 (responses name their company; saves from a tab on the wrong company are refused); B8, B9 (route-scoped body limit, helmet, CORS fails at boot, global throttle); B10 friendly Prisma errors; B11 (`@Max`/`@MaxLength`/`@IsBase64`); B14; B15; B16; C3, C9; shared upload helpers for B4, B5 (`detectContentType` allow-list, a single size constant, image compression and thumbnail service) | No |

**Repairing existing data.** F1, F2 and O1 may already have corrupted real records, such as advances closed early or double deductions. Streams 1a and 1b each write a **read-only report script** that lists affected records. You decide whether to repair them before any data is changed.

### Wave 2: frontend foundation kit (one agent, web). Runs alongside Wave 1.

This is a different repo, so it doesn't conflict with Wave 1.

1. **Errors:** A1 (error boundaries, not-found page, chunk-reload), A2, A3 (`apiFetch` timeout, network error, validation message clean-up), A4 (`<QueryError onRetry>`, retry policy for GETs only), A5 (module guard error state).
2. **Interaction:**
   - A7: `Button` and `RowAction` get a `loading` prop and auto-disable.
   - A8–A10: modal stack, dirty-form guard, `useId`, scroll lock.
   - A17: toast provider.
3. **Formats:** A18, A20 (one module for dates in DD-MM-YYYY, currency in ₹ and quantities, plus a lint ban on inline `toLocale*`).
4. **Lists:**
   - A13: server sort support.
   - A14: `useUrlState`.
   - A15: `useDebounced` + `keepPreviousData`.
   - A16: row skeletons in `ResponsiveList`/`DataTable`.
5. **Pickers:** A11, A12, an async `SearchableSelect` (server search, "type to search", shows a count, never truncates silently).
6. **Uploads:** A27, `<FileUpload>` (accept list, size check, canvas resize to WebP/JPEG, thumbnail, progress, resets on error).
7. A24 return-to-path after login; A26 user-scoped drafts cleared on logout.
8. B17: `apiFetch` sends the company the tab believes it is in, and shows a "Company changed in another tab" banner with Reload when the server says otherwise.

The existing screens keep working throughout. Wave 3 switches them over to the kit.

### Waves 1 + 2: outcome (17-10-2026)

All six streams are merged into `036-ux-qa-hardening` locally (not pushed). Each was rebased and re-verified by the coordinator before its merge, then all were re-verified together.
- **API:** `tsc` clean; 249/249 unit suites (2,763 tests).
- **Combined e2e:** a fresh database with all migrations applied ran each stream's suites one at a time: 16 suites, 365 tests, all pass.
- **Web:** `typecheck` clean; lint shows the 11 known warnings.
- **Already-failing e2e suites:** some suites outside these streams already failed on the base commit (fixtures still send a project `code`, plus missing seed defaults; see README-e2e). They fail identically now.

**Migrations, in order:**
- `20261017140000_payroll_recovery_settlement`
- `20261017150000_labour_payment_sheet_carry_forward`
- `20261017160000_transfer_shortage_reason`
- `20261017160100_payment_idempotency_key`
- `20261017160200_logbook_reading_gap_reason`
- `20261017160300_hire_bill_created_by`

**Where it differed from the plan:**
- **Migration ranges:** the first ranges given to the streams clashed with existing migrations, so the streams were moved to ranges after `20261017130000`.
- **Default body limit:** 1 MB, not 100 KB. The largest bill and BOQ saves were never measured.
- **Saved drafts:** user-keyed bill drafts survive session expiry and are cleared only on sign-out.
- **FR-022 guard:** the guard spec now excludes `src/**/dto/**` plus each stream's files, with notes.
- **Release requirements:** production now refuses to boot without `CORS_ORIGINS`, and `helmet` is a new dependency.

**Inputs for Wave 3:**
- **Each stream's report lists the API changes the web must adopt.** These include: bank sheet by POST; run detail server totals and exceptions; new 409/403 codes (`PAYROLL_DRAFT_STALE`, `PAYROLL_RUN_NOT_APPROVED`, `SELF_APPROVAL`, `COMPANY_CHANGED`, `RA_BILL_EXCEEDS_AWARD`, `LABOUR_SHEET_PERIOD_NOT_ENDED`, …); payment sheet delete, regenerate and carry-forward rows; `punchOutNextDay` / `openShiftFrom`; O8 names; `shortageReason`, `returnedNow`, `Idempotency-Key`, `readingGapReason`, `taxBasisWarning`; paging params; clients send `null` to clear; geofence max 5000; mirror the new `bill-totals.ts` rounding.
- **Selected-company bugs still in module code:** platform listed about 20 places that use the home company instead of the selected one:
  - `user.companyId ?? requested` in hr attendance (holidays, import, admin), employees, payroll (loans, reimbursements-admin, tds, salary-advances, challans, runs), and projects sites.
  - Other reads in labour payment sheets, recruitment letters/requisitions/refs, the asset register and the salary-advances service.
  - Each module stream fixes its own with `resolveCompanyId` / `effectiveCompanyId`.
- **Exports still needing `@ExportThrottle()`:** disposals, project P&L, salary register, challans, asset register.

**Wave 1+2 review decisions (accepted 17-10-2026):**
1. Stale payroll draft refused until regenerated: keep.
2. A punch from a phone clock more than 5 minutes behind is recorded at server time and flagged: keep.
3. Labour carry-forward goes onto the next sheet at any site: keep.
4. Fully paid labour sheets still can't be reversed (pre-existing): leave for later.
5. **Separate project-unlock permission: build in 3c (migration).**
6. Locked projects still accept payments and signed copies: keep.
7. Unpaged billing lists capped at 500 per project: keep; screens use paging in 3c.
8. Logbook reading gaps need a reason: keep.
9. **Block *adding* logbook entries inside a verified or paid hire-bill period too: build in 3d.**
10. Prose headings stay; lists, forms and exports use DD-MM-YYYY: keep.

### Wave 3: module slices (5 agents in parallel, both repos per module)

Each agent owns one module in **both** repos: the remaining backend items for that module (new view endpoints, filters, names instead of UUIDs) and every screen fix. Each one also adopts the Wave 2 kit (pickers, error states, URL state, uploads, confirmations, pending locks) and wires up the Wave 1 backend changes.

| Stream | Items |
|---|---|
| **3a settings, approvals, dashboard** | C1–C18, D1 (server `from`/`to`/`q` + month picker + export), D2–D5, D6 (saved notifications with read/unread, mark-all-read, no emails; **migration**), E1–E5 |
| **3b HR, ESS, recruitment** | F8, F9, F10, F12–F21 screens; F14, F15, F17 view and replace endpoints + employee document metadata (**migration**); G2–G5; H1–H5 |
| **3c projects, documents, letters** | I6–I18, I21–I25; I9 attachment delete endpoint; J1–J4; DWR autosave |
| **3d plant, assets** | K6 (edit-readings flow with reason and audit), K7, K9, K12–K17 screens; K14 optional main photo + gallery, compressed, with thumbnails (**migration**); L2–L4 |
| **3e inventory, partners, labour** | M9 structured PO lines behind the **unchanged** PO format, purchase→PO line link, over-receipt refusal, PO traceability (**migration**); M3, M5, M7, M8, M10–M13 screens; M11 photo endpoint; N1–N6 (N4 contractor document view endpoint); O6–O13, O15; O8 names from the API |

The backend upload pipeline (B4–B7) also lands here, through each module's upload routes, using the helpers from stream 1e.

### Wave 3: outcome (17-10-2026)

All five module streams are merged into `036-ux-qa-hardening` in both repos (local). Each was rebased and re-verified before merging. Then everything was verified together:
- **API:** 256/256 unit suites (2,847 tests).
- **API e2e:** a fresh database with all 12 of 036's migrations, 33 suites run one at a time. All pass except `plant`'s 2 failures, which already failed before 036 (plate number, hire-bill net).
- **Web:** `typecheck` clean; lint shows 2 warnings and 0 errors; `next build` succeeds.

**Migrations added in Wave 3:**
- `20261018100000_notification_inbox`
- `20261018110000_employee_document_versions`
- `20261018120000_project_lock_permission`
- `20261018120001_project_lock_grants`
- `20261018120002_dwr_attachment_thumbnail`
- `20261018130000_equipment_photos`
- `20261018140000_purchase_order_lines`

**Notable:**
- The M9 PO document snapshot (text, layout, PDF hash) is unchanged.
- The bank-sheet GET routes were removed once the web switched to POST.
- `PROJECT_LOCK` is granted to every role that held PROJECTS.
- A B11 regression was fixed: the labour cash acknowledgement photo had been refused.

**Follow-ups not done in Wave 3 (candidates for Wave 4 or a later pass):**
- **K15 pickers:** five plant pickers are still capped at 200 (job card, job parts, hire-order modal, equipment-modal vendor/site, spare-part vendor).
- **Paging totals:** the web client can't read `X-Total-Count`, so interview and bank-history pagers show no page count. Expose headers in `authFetch`, or return `{items,total}`.
- **Company-scoped custom roles (C10):** needs a migration.
- **"Personal Settings" name (C16):** kept, because the client chose it.
- **Decimal entry:** the certified-quantity input in `client-bill-view` is still `type=number`.
- **RA bills:** add a `workOrderId` filter on `GET /projects/ra-bills`.
- **Labour project pickers:** labour wage rates and reports still load 200 projects.
- **Resignations report:** refetches on every date change, the same bug H5 fixed for new joinings.
- **ESS payslip PDF:** uses a raw `fetch`.
- **e2e test environment:** dashboard needs the `QA No Modules` fixture role; letters, letters-regression and bill-package debits fail as they did before 036.

### Wave 4: outcome (18-10-2026)

Both agents are merged and pushed.

**Design system + accessibility:**
- Every button variant is in `app/ui/button.tsx`.
- About 70 raw buttons were migrated; the rest are custom controls with the shared focus ring.
- StatusBadge uses semantic tones; 27 hand-made pills were migrated.
- 51 faint grey text classes were darkened, and nothing is below 12px.
- Required markers, `aria-required` and `aria-describedby` are built into the fields.
- Tablet icon rail, scrolling tab cues, and breadcrumbs on 12 detail pages.
- The login page was rebuilt.
- Lint regression rules were added.
- The transitional `blue: brand` remap is removed; `blue` is Tailwind's own again.

**Follow-ups:**
- The last 5 plant pickers now search the server.
- Interview and bank-sheet history pagers show page counts (`authFetchWithMeta`, `X-Total-Count` exposed).
- **Company-scoped custom roles** (`20261019100000_company_scoped_roles`, backfilled from holders).
- Client-bill decimal entry; RA bills filtered by work order; labour project pickers search the server.
- Resignations report fixed; payslip PDF goes through the authenticated helper.
- `npm run seed:defaults`.

**e2e:** every suite that failed before 036 was stale against intended behaviour or missing setup, not a code bug. All are green now:
- settings, dashboard, assets, plant, dwr, letters, letters-regression, bill-package, ra-bills.
- Debit notes have no e2e coverage now (unit spec only).

**Results:** API 256/256 unit suites (2,848 tests). Web typecheck clean, lint 0 errors / 2 old warnings, `next build` succeeds.

**Still open from Wave 4:**
- `PUT /approvals/slot-mappings` doesn't refuse another company's role.
- Account creation lists every visible role (the server refuses a wrong one).
- Three plant pickers are still capped at 200: service-bill vendor, the equipment page site filter, and the spare-part linked item.
- File-download controllers still override the exposed headers, hiding `X-Company-Id` on downloads.

### Wave 5: outcome (18-10-2026)

**Browser walkthrough.** Production builds on separate ports, against a copy of the local `buildcore` data. Headless Chrome visited all 142 routes at 1440, 820 and 390 px: 426 page visits, recording failed API calls, console and page errors, error boxes, horizontal overflow and screenshots.

**Found and fixed (merged, pushed):**
- A missing stored file returned 500 instead of 404, which broke company logos. Both storage adapters now return 404, with a spec.
- The group P&L refused 4 or more projects: B11 had capped `projectIds` at 100 characters. It now allows 200 ids.
- `@MaxLength` was duplicated beside `@Length` on 4 fields, which made the generated `src/metadata.ts` fail to type-check. Any local `metadata.ts` generated before this needs deleting once.
- The equipment register scrolled sideways on phones, because of a long documents badge.

**Live API checks pass:** Inactive filter (B12), invite rate limit (B1), `X-Company-Id` and `COMPANY_CHANGED` (B17), helmet headers (B9), and a friendly 413 above the default body limit (B8).

**Full e2e** on a freshly provisioned database (`migrate deploy`, `db seed`, `seed:chains`, `seed:defaults`), every suite one at a time: 58 suites, all pass. `account-creation` and `search` failed once in the full run, then passed on two re-runs, including in the same order. Treated as flaky timing (first suites while the compile cache was cold).

**Manual checklist:** `manual-checklist.md`.

### User review after Wave 5 (18-10-2026)

Found by the user, not by the crawl, which checked for crashes, failed requests and overflow but never whether text was readable or a flow made sense. All fixed and checked in the browser:

- **Pickers inherited the banner's white text.** On the Site Dashboard's navy banner the site list rendered white on white. `AsyncSelect` and `SearchableSelect` now set their own text colour.
- **HR attendance calendar went into future months, and showed future days as Absent.** Next stops at the current month; days after today read "Upcoming" unless they are a holiday, weekly off or approved leave. My Workspace attendance no longer lists the rest of the month as Absent. The server's day rule is unchanged, because payroll reads it.
- **Bank sheet and monthly attendance asked for a company the header already names.** The company now comes from the header and is shown as read-only text.
- **Every letter template reported undeclared variables.** The editor hid any field whose name contained "pan", which matched "com**pan**y"; it also hid typed-in vendor PAN, IFSC and account number fields the server allows, and did not know the tokens the render fills itself (`SUPPLIED_TOKENS`). The server's save check didn't know them either. Both sides now match "pan" as a whole word, and both accept `SUPPLIED_TOKENS`.
- **"In force today: Director required" was not understood.** The badge now reads "Now: Needs Director approval / No Director approval needed / Not set — default applies", and the checkbox reads "Require Director approval".
- **Still open:** an employee profile from another company opens under the header's company, but its attendance tab answers 404. Either the profile should refuse too, or the tab should read the employee's own company.

### Remaining for the final pass (written 18-10-2026, while Wave 4 runs)

Wave 4 runs two agents: **design system + accessibility** (A21–A23, A29, A16, lint rules) and **follow-ups** (the Wave 3 list plus company-scoped roles and the e2e environment). Everything below is outside both.

**Need a product decision or a migration (deferred so far):**
1. **Purchase GST, invoice number and accepted quantity:** purchases record no GST % or invoice number, and stock is credited with the billed quantity rather than the accepted quantity. This is separate from the PO format, which stays unchanged.
2. **Fully paid labour sheets can't be reversed.** This was the case before 036 (review decision 4: later).
3. **Fuel tank capacity:** a flag for fills larger than the tank needs a tank-capacity field on equipment or its category.
4. **NOC photo thumbnails:** need a column.
5. **"Personal Settings":** rename it, or keep the client's name.

**Engineering items not yet done:**
6. **Bypass contexts (B15):** an allow-list for the ~110 hard-coded RLS bypass contexts. Today all callers pass a context, but nothing enforces it.
7. **Search permissions:** search has no permission guard, by choice. It checks permission per register, and a guard would turn empty results into 403s.
8. **Fuel recovery and hire bills:** fuel recovery can still push a hire bill's net negative (no check in fuel-recovery recompute).
9. **Logbook sheet:** errors other than the reading rules can still leave a sheet half-written. Correcting a day's readings doesn't re-check the next day's opening reading.
10. **Hand-typed PO lines:** a line typed without picking an item can be traced but not received against.
11. **Client-side filtering:**
    - labour daily name/code search (the endpoint has no search);
    - workers' NOC filter (applies to the current page only);
    - partners RAG/BOCW filters (the endpoints return the full set).
12. **Mobile Safari:** PDF print can come out blank, and the "View receipt" / new-tab fallback can be popup-blocked.
13. **Operator picker scope:** it searches the whole company, not just the machine's site.

**Data and release (needs you):**
14. **Run the read-only data-repair reports against real data and decide on repairs:**
    - `scripts/036-report-payroll-recoveries.ts` (F1–F5)
    - `scripts/036-report-labour-advances.ts` (O1)
    - M2 historic issue fulfilment (no script yet)
15. **Deployment:**
    - set `CORS_ORIGINS` (or `none`);
    - `npm install` (helmet);
    - `prisma migrate deploy` (19 new migrations; more if Wave 4 adds any);
    - restart the API so `src/metadata.ts` regenerates.
16. **Release note for users:**
    - DD-MM-YYYY dates and 24-hour IST times;
    - stricter upload types and sizes;
    - nobody approves their own requests;
    - labour sheets must end before today;
    - logbook reading gaps need a reason;
    - transfer shortages need a reason;
    - payroll drafts must be regenerated if inputs changed;
    - company-changed warning across tabs.

**Wave 5 (verification, me):** click through every module in a browser (desktop, tablet and phone widths), run the audit's 35 reproduction steps, run full unit and e2e on a freshly provisioned database, and write a manual checklist for you. Then merge `036-ux-qa-hardening` into `004-dashboard-backend` / `004-dashboard`.

### Wave 4: design system and accessibility (one agent, web, last)

- **Design system:** A21 (button variants in one place, StatusBadge on semantic tokens, Tailwind config fix, migrate the 128 raw buttons and 32 hand-made pills).
- **Accessibility:** A22 (contrast, minimum text size, required markers).
- **Navigation and viewer:** A23 (tablet sidebar rail, tab scroll cues, breadcrumbs), A28 (Print + focus trap), A29 login.
- **Lint rules** to keep these from coming back.

### Wave 5: checking it all works (me)

- Full unit and e2e suites on a fresh test database.
- Run the app and click through each module's main flows and the 35 reproduction steps from the audit.
- A short manual-verification checklist for you.
- Merge `036-ux-qa-hardening` into `004-dashboard-backend` and `004-dashboard` when you approve.

---

## 3. Order and rough size

```
Wave 0  ──►  Wave 1 (5 api agents)  ─────────┐
        └──► Wave 2 (1 web agent, same time) ─┴──► Wave 3 (5 module agents) ──► Wave 4 ──► Wave 5
```

| Wave | Agents | Relative size | Review checkpoint |
|---|---|---|---|
| 0 | me | S | quick look |
| 1 | 5 parallel | L (most careful work) | **review the money and data diffs + data-repair reports** |
| 2 | 1 (alongside 1) | M | review the kit API before Wave 3 adopts it |
| 3 | 5 parallel | L (most lines changed) | per-module demo |
| 4 | 1 | M | visual pass |
| 5 | me | S–M | final sign-off |

If you'd rather go slower, Waves 1 and 3 can run as 2–3 agents at a time. The order stays the same and the elapsed time roughly doubles.

---

## 4. Decisions (all made, 17-10-2026)

**Implementation choices: all 10 defaults accepted.**

1. **Payroll recoveries (F1/F2):** settle advances and fuel recoveries only when the run is **processed**, not at draft. *Default: yes.*
2. **Labour carry-forward (O4):** add a short payment to the next sheet as its own line. *Default: yes.*
3. **Transfer shortage (M3):** a received quantity below what was sent needs a reason and is recorded as a **loss** at the destination. It does not go back to the source. *Default: loss.*
4. **Maker-checker (F19, M8, O12, K8):** block self-approval everywhere, with no company override. *Default: block, no override.*
5. **Punch time (G1):** use the server's receive time, and accept the phone's clock only within ±5 minutes. *Default: yes.*
6. **Overnight shifts (O5):** an out-punch attaches to the latest open in-punch within 16 hours. *Default: 16 h.*
7. **Date display (A18):** `DD-MM-YYYY` everywhere, or `17 Oct 2026` in lists and `DD-MM-YYYY` in forms and exports? *Default: DD-MM-YYYY everywhere, as you asked.*
8. **Multi-role users (C1):** let the Users screen assign several roles. *Default: multi-select.*
9. **Upload limit (B4):** keep 10 MB per file and switch to multipart uploads (bigger change), or keep JSON and raise the body limit only on upload routes (smaller)? *Default: route-scoped limit now, multipart later.*
10. **Data repair (F1/F2/O1):** report only, then you decide. *Default: report only.*

**Product decisions:**

| Item | Decision | What gets built | Stream |
|---|---|---|---|
| **M9 purchase orders** | **Make POs structured, but keep the current PO format exactly as it is.** | <ul><li>**Keep the PO document as it is:** the letter, its layout and the printed or PDF output stay as they are today. A before-and-after comparison test of the generated PO enforces this.</li><li>**Store the lines behind it:** item, quantity, unit, rate and GST, exactly as they already appear on the PO.</li><li>**Link purchases to PO lines:** each purchase (GRN) links to the PO line it delivers against, and receiving more than was ordered is refused.</li><li>**Trace every PO:** each PO shows ordered, received, billed and paid, and you can follow it from PO to GRN to payment.</li></ul> | 3e (**migration**) |
| **K10 fuel GPS** | **Not required.** | No GPS or geofence check on fuel. The rest of K10 stays in 1d: refuse 0-litre entries and future dates, and flag fills larger than the tank. | — |
| **K14 equipment photos** | **Main photo + gallery, optional.** | <ul><li>**Optional:** a main photo plus a gallery, and a machine never needs a photo.</li><li>**Compressed:** every photo is compressed when uploaded, in the browser (resized to about 2048 px, WebP or JPEG) and again on the server, and a thumbnail is generated for the list and detail views.</li><li>**Fallback:** machines without a photo show a placeholder icon.</li></ul> | 3d (**migration**) |
| **D6 notifications** | **In-app inbox with read/unread only. No emails.** | Notifications are saved with read/unread state. The bell shows a badge count, and there are "Mark as read" and "Mark all read" actions. No approval or reminder emails. | 3a (**migration**) |
| **B17 company selection** | **Detect and warn.** | <ul><li>**One selection per user:** the selected company is still stored per user.</li><li>**Server side (1e):** every response says which company it was served for, and each save carries the company the tab thinks it is in. A save whose company doesn't match is refused with "Company was changed to X in another tab. Reload to continue."</li><li>**In the browser (Wave 2 kit):** a tab that notices the company changed elsewhere shows a banner with a Reload button.</li></ul> | 1e + Wave 2 |

---

## 5. Risks

- **Merge conflicts on shared files.** Handled by building the kit in Wave 2 before Wave 3 starts, and saving the repo-wide design-system pass for Wave 4.
- **Migration ordering.** Only 1a, 1b, 1d, 3a, 3b, 3d and 3e may add migrations, and I merge them in timestamp order.
- **PO format drift (M9).** A comparison test of the generated PO document, captured before any change, must pass unchanged.
- **Existing bad data.** Handled with report scripts before any repair (decision 10).
- **Behaviour changes users will notice,** such as the stricter maker-checker, payment sheets that end before today, and transfer shortage reasons. These go in a release note for the client.
- **Peer sessions on the main checkout.** All agents work in worktrees with their own databases, as the existing project practice requires.
