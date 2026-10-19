# BuildCore UX / UX Eng / QA audit (17-10-2026)

**Scope:** buildcore-web (Next.js, 529 files, about 120k lines) and buildcore-api (NestJS + Prisma), branch `004-dashboard-backend`.

**How it was done:**
- Code was reviewed screen by screen across both repos.
- Two backend bugs were reproduced in a small test app: the invite rate limit isn't enforced, and an 8 MB upload is rejected.
- Everything else was checked by reading the code. **Nothing was clicked through in a browser.** Rows marked *(verify)* need a quick manual check.

**Checks that were run:**
- **API:** `tsc` clean. Unit tests: 220/220 suites and 2,500/2,500 tests pass. One open-handle warning appears at teardown.
- **API e2e: not run.** The e2e config has no separate test database, so it would write to the shared dev database.
- **Web:** `tsc` has 3 errors, all in stale `.next/types`. Lint reports 57.9k problems, almost all from `.claude/worktrees/**`; `app/` itself has 11 warnings.

**Already in good shape (no action needed):**
- Row-level security is on all 155 company-scoped tables.
- The selected company is resolved on the server, and routes fail closed if no permission is declared.
- The global `ValidationPipe` uses whitelist + forbidNonWhitelisted.
- Disposal is enforced as Super Admin-only on the server.
- Biometric photos are checked by their actual bytes and compressed.
- Files are stored in encrypted S3, not the database.
- No `window.confirm`/`alert` anywhere.
- Icon buttons have aria-labels.
- The service worker never caches API responses.
- Approval decisions are protected against races.
- Reject requires a reason and a confirmation.

Severity: **C** Critical · **H** High · **M** Medium · **L** Low. Category: UX · UX Eng · QA · BP (Best Practice) · Sec (Security).

---

## A. App-wide frontend foundation

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| A1 | Global | BP | No `error.tsx`, `global-error.tsx` or `not-found.tsx`, and no error boundary. A render error, or a chunk failing to load after a deploy (`skipWaiting:true`), shows a blank "Application error" page. | Add `global-error.tsx`, `dashboard/error.tsx`, `my/error.tsx` with Retry and Home buttons, and a branded `not-found.tsx`. Reload automatically on ChunkLoadError. | H | `find app -name error.tsx` → 0; `app/sw.ts` |
| A2 | API client | UX Eng | `apiFetch` has no timeout. A dropped connection throws a raw `TypeError`, so screens can hang or show generic text. | `AbortSignal.timeout(30s)`; turn network errors and timeouts into `ApiError(0,'NETWORK')` with the message "Check your connection". | H | `lib/api/client.ts:37` |
| A3 | API client | QA | Nest validation errors arrive as a `string[]` and are shown comma-joined ("amount must not be less than 0,property x should not exist"). A non-JSON 502 shows an empty error box. | Normalise in one place: join arrays or map them to fields, and fall back to "Server error (502)". Optionally add a friendly `exceptionFactory` on the API. | H | `client.ts:52`; api `configure-app.ts:42` |
| A4 | React Query | UX Eng | `retry:false` everywhere and no shared ErrorState. Only 3 files wire `refetch()`. `ResponsiveList` (68 users) and `DataTable` (39 users) show errors as text with no Retry. 38 files never read `isError`. | Add a `<QueryError onRetry>` component and build it into both list components. `retry: (n,e) => n<2 && !(4xx)` for GETs only. | H | `providers.tsx:23`; `settings/responsive-list.tsx:87` |
| A5 | Module guard | UX | Any failure loading `/me` (offline, 500) replaces the page with a lock-icon "Access denied" screen with no Retry. Plant and Assets layouts do the same. | Add a separate "Couldn't load your workspace" state with Retry; keep Access denied for real refusals only. | H | `ui/dashboard/module-guard.tsx:73`; `plant/layout.tsx:77` |
| A6 | Button | QA | `Button` defaults to `intent='write'` and disappears for read-only users. This hides the labour Attendance and Deployment **Run** buttons, letter **Download/Preview**, and "Open the report". | Make `read` the default intent, or set `intent="read"` at these 6 sites. | H | `ui/button.tsx:40`; `labour/reports/attendance/page.tsx:101`; `deployment/page.tsx:97`; `letters-panel.tsx:486` |
| A7 | Double submit | QA | `Button` has no pending lock. 33 action controls call `.mutate()` without `disabled`: muster/payment-sheet Approve, requisition Submit/Approve/Delete, gang, wage-rate and advance Save, interview Schedule, reimbursement and salary-advance Approve. | Add a `loading` prop to `Button`/`RowAction` (auto-disable while pending) and pass `isPending` at all 33 sites. | H | `labour/payment-sheets/[id]/page.tsx:257`; `musters/[id]/page.tsx:161` |
| A8 | Modal (77 users) | QA | Escape is captured at the document level with no layer check. Escape on a confirm dialog, calendar or dropdown inside a modal closes the **whole modal** and loses the input. | Keep a modal stack so only the top layer handles Esc, and respect `defaultPrevented`. | H | `settings/modal.tsx:45`; `native-pickers.tsx:332`; `dialogs.tsx:171` |
| A9 | Modal | UX | Esc or X closes even when the form is dirty or a save is in flight. Only 2 of about 77 modal forms use the unsaved-changes guard, and navigating within the app isn't guarded. | Add an `isDirty` prop that asks "Discard changes?", block close while pending, and guard Link clicks. | M | `lib/unsaved-changes.ts` |
| A10 | Modal | BP | Hard-coded `id="settings-modal-title"` duplicates ids when modals stack. The page scrolls behind the modal on mobile, and `92vh` hides the footer under the iOS toolbar. | `useId()`, lock body scroll, `max-h-[92dvh]`. | L | `modal.tsx:73,79` |
| A11 | Pickers | UX | `SelectField` is used 235 times and `SearchableSelect` only 6 times. Long lists (employees, sites, projects, clients, vendors, items, machines, workers) are plain selects. | Use `SearchableSelect` with server search for any list that can exceed about 30 options. | H | `native-pickers.tsx:241` |
| A12 | Pickers | QA | Pickers load `pageSize:100/200` (the server maximum), with 58 such calls. Record 101 or 201 onward **silently disappears**: employees (HR, operators, custodians), items, vendors, machines, workers, clients, candidates. Several HR pickers also include employees who have left. | Async search picker plus `isActive:true`. See per-module rows. | H | `lib/api/hr-payroll.ts:273`; `inventory/use-inventory-refs.ts:23`; `plant/use-plant-refs.ts:44` |
| A13 | Lists | QA | Header sort reorders only the 20–25 rows on the current page of server-paged lists. | Sort on the server, or disable sort when a pager is shown. | M | `responsive-list.tsx:78` |
| A14 | Lists | UX | Filters, search and page live in `useState` on 22 list screens, so they are lost on Back and can't be shared as a link. | Add a `useUrlState` hook that syncs them to the query string. | H | `hr/employee-list.tsx:41`; `plant/equipment/page.tsx:49` |
| A15 | Lists | UX Eng | Search fires a request on every keystroke on 14 screens, and the table flashes "Loading…" because previous data isn't kept. | Debounce about 300 ms and use `placeholderData: keepPreviousData`. | M | `projects/clients/page.tsx:50`; `partners/vendors/page.tsx:48` |
| A16 | Loading | UX | Four loading patterns are in use (LoadingText ×78, Spinner, overlay, skeletons). Tables collapse to one "Loading…" line, so the layout jumps. | Add row skeletons in the shared lists; delete the unused tutorial skeletons. | L | `ui/skeletons.tsx` |
| A17 | Feedback | BP | No toast system (a few ad-hoc banners), so saves, updates and deletes give inconsistent or no success feedback. | Add one toast provider (success/error) and call it from shared mutation helpers. | M | — |
| A18 | Dates: format | UX | `dateLabel`, `periodLabel` and `dateTimeLabel` follow the browser locale (en-US shows "Oct 16, 2026"). 18 inline `toLocaleDateString` calls use 5 different locales. | One formatter, fixed to **DD-MM-YYYY**, with a lint ban on inline `toLocale*`. | M | `lib/format.ts:63,75,88` |
| A19 | Dates: time zone | QA | 34 places set "today" with `toISOString().slice(0,10)` (UTC). `currentPeriod()` is also UTC. `dateLabel` forces UTC on timestamps. Between 00:00 and 05:30 IST, forms default to **yesterday**, the period defaults to **last month** on the 1st, and approvals show the previous day. | Use `todayIso()` (IST) everywhere; fix `currentPeriod()`; use `BUSINESS_TIME_ZONE` for timestamps. | M | `format.ts:79,123`; `fuel-modal.tsx:53`; `issue-modal.tsx:26` |
| A20 | Currency / qty | BP | 68 literal `₹` with ad-hoc `toLocaleString`, and 5 local re-definitions of `rupees`/`money` (one without ₹). `formatCurrency` divides by 100. Quantities print raw floats (807.4639999) or `toFixed(3)` without grouping. | Use `rupees()`/`quantity()` only, add a `quantity3()`, delete the duplicates. | L | `debit-notes-panel.tsx:42`; `lib/utils.ts:3` |
| A21 | Design system | BP | 128 raw `<button>`s and 32 hand-made status pills. `success/warning/danger` tokens are used 0 times against 981 raw colour classes. `blue` is remapped to the brand colour. `keyframes` sits outside `extend`, which breaks the built-in animations. | Put all button variants in `ui/button.tsx`, make StatusBadge use semantic tokens, and fix the Tailwind config. | M | `tailwind.config.ts:91`; `settings/form-fields.tsx:215` |
| A22 | Accessibility | UX | `text-gray-400` (≈2.6:1 contrast) is used 69 times for real text, and `text-[11px]` 12 times (mobile nav). Required fields have no `*` / `aria-required`, and errors appear in a top banner far from the field. | Use at least gray-500 and 12px; add required markers; focus the first invalid field. | M | `mobile-nav.tsx:197`; `settings/form-fields.tsx:62` |
| A23 | Shell | UX | From 768 to 1023 px the fixed 256 px sidebar leaves about 500 px for wide tables. Section tabs scroll with no cue (Settings has 15, HR 11). No breadcrumbs outside Projects, and 25 hand-built back links. | Icon rail at `md`; fades or arrows on the tabs; breadcrumbs in `PageHeader`. | M | `dashboard/layout.tsx`; `ui/section-tabs.tsx` |
| A24 | Session | UX | When the session expires, the user goes to `/login` with no return path and lands on home. | Add `&next=` (same-origin) and honour it after login. | M | `lib/session.ts:304`; `login-form.tsx` |
| A25 | Session | QA | `refreshInFlight.finally()` leaves an unhandled rejection, logging "Uncaught (in promise)" on every failed refresh. | `.catch(()=>{}).finally(...)`. | L | `session.ts:188` |
| A26 | Local storage | Sec | IndexedDB bill drafts and the old punch queue aren't keyed by user or cleared on logout. On a shared device the next user sees, or sends, the previous user's data. | Include the user id in the key and clear on logout or 401. | M | `lib/bill-drafts.ts:47`; `lib/offline-queue.ts` |
| A27 | Uploads (all) | UX Eng | No upload compresses images on the client (except the face camera). Most have no `accept`, no size check before base64, no preview and no progress. File inputs aren't reset, so picking the same file again after an error does nothing. | One shared `<FileUpload>`: accept list, size check, canvas resize to about 2048 px JPEG/WebP, thumbnail, progress, reset on error. | H | `purchase-modal.tsx:135`; `documents-tab.tsx:80`; `dwr-form.tsx:1135` |
| A28 | File viewer | UX | No Print button (iPad and Android have no PDF toolbar) and no focus trap. | Add Print; reuse the focus trap from `dialogs.tsx`. | M | `ui/pdf-viewer.tsx` |
| A29 | Login | UX | A network failure shows "Something went wrong."; there's no `role=alert`; and the page still uses the Next tutorial styling. | Specific messages, `role="alert"`, and build it from `TextField`. | L | `login-form.tsx:76` |
| A30 | Root metadata | BP | `themeColor`/`colorScheme` sit in `metadata`, so the PWA theme-color isn't output. | Move them to `export const viewport`. | L | `app/layout.tsx:45` |
| A31 | Tooling | BP | Lint is unusable because `.claude/**` isn't ignored, and `tsc` fails on stale `.next/types`. | Add `.claude/**` to the ESLint ignores and run `next typegen` before `tsc` in CI. | M | `eslint.config.mjs:11` |

## B. Backend platform (security, uploads, errors)

| # | Area | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| B1 | Invites | Sec | `@Throttle` is set on the public invite and set-password routes, but no `ThrottlerGuard` is attached, so tokens can be guessed without limit. **Reproduced:** 25/25 requests return 200; with the guard, 10 return 200 and 15 return 429. | Register `ThrottlerGuard` as a global `APP_GUARD`, with a generous default limit. | C | `account-creation/invites/invites.controller.ts:26`; `app.module.ts` |
| B2 | Approvals spine | QA | `stateOf`/`statesOf`/`historyOf` use the **home** company. A Super Admin who has selected another company sees no Approve/Reject on work orders and bill packages and an empty history, and attendance exceptions return 404. | Use `rlsContextFor(viewer)` and add an e2e test. | H | `approvals/approvals.service.ts:571,616,671` |
| B3 | Selected company ignored | QA | The same home-company mistake affects the activity log, reminders, the site dashboard list, async report export (500 from the row-level security check) and Employee Setup reference-data create (500/404). | Use `effectiveCompanyId(user)` everywhere; grep for `user.companyId`. | H | `activity-log.service.ts:171`; `reminders.service.ts:139`; `site-dashboard.controller.ts:41`; `export-job.service.ts:115`; `reference-data.service.ts:267` |
| B4 | Uploads | QA | The UI and API say "up to 10 MB", but base64 inside a 10 MB JSON body caps real files at about 7.5 MB. An 8 MB file gets a raw `413` (**reproduced**). Affects NOC, disposal, equipment, asset, DWR and project documents. | Short term: raise the limit on upload routes to about 14 MB and use one shared constant in UI and API. Long term: multipart with per-route `FileInterceptor` limits, or presigned S3. | H | `common/configs/config.ts:134`; `configure-app.ts:35` |
| B5 | Uploads | Sec | No type allow-list on most document uploads. The client's `contentType` is stored and served back. Only DWR, signed copies and client bills check the actual bytes. No `nosniff`, no virus scan (`TODO(VIRUS_SCAN)`). | `detectContentType` + allow-list (PDF/JPEG/PNG/WebP/Office) and store the detected type. Plan ClamAV or an S3 scan. | M | `nocs.service.ts:168`; `equipment.service.ts:906`; `purchases.service.ts:128` |
| B6 | Uploads | BP | Non-biometric images are stored at full size (DWR photos, purchase bills, project documents) with no thumbnails and no PDF compression. | Compress on upload (`ImageProcessingService.compress`, about 2048 px q80) and make a 320 px thumbnail for lists. | M | `dwr.service.ts:609`; `purchases.service.ts:135` |
| B7 | File serving | BP | Files are loaded fully into memory. No `Cache-Control`/ETag except on the company logo, so every view downloads and decrypts again. | `Cache-Control: private, max-age, immutable` + ETag for refs that never change. | L | `s3-storage.adapter.ts:91` |
| B8 | Body parser | Sec | The 10 MB body limit applies to **every** route. | Default about 100 KB; use the large limit only on upload routes. | M | `configure-app.ts:35` |
| B9 | Hardening | Sec | No helmet (nosniff, HSTS, frame-ancestors). If `CORS_ORIGINS` is unset, any origin is allowed with credentials. Throttling covers only auth. | `helmet()`; refuse to boot in production without `CORS_ORIGINS`; global throttle with tighter limits on exports. | M | `main.ts:76`; `config.ts:144` |
| B10 | Errors | QA | The Prisma filter maps only P2000/P2002/P2025. Foreign-key, out-of-range and write-conflict errors become 500. Messages leak schema details ("[P2002]: Unique constraint failed on (`companyId`,`code`)"). The filter isn't in `configureApp`, so e2e tests behave differently from production. | Custom mapping with friendly text + `code`; move it into `configureApp`; add a global filter that always emits `{statusCode, code, message}`. | M | `main.ts:44-46` |
| B11 | Validation | QA | Money fields have no `@Max` (Decimal(12,2) columns), so 1e12 gives a 500. 761 `@IsString` vs 319 `@MaxLength`. Base64 fields are `@IsString` only. `@Body('reason')` skips the DTO. | Add `@Max` matching column precision, `@MaxLength` on all strings, and `@IsBase64`. | M | `salary-advance.dto.ts:22`; `loans.controller.ts:126` |
| B12 | Boolean query | QA | `@Type(() => Boolean)` turns `"false"` into `true`. **The employee Inactive filter returns active staff**, and the same pattern is in items, stock, allocations and assets. | `@Transform(v => v==='true'\|\|v===true)`. | H | `hr/employees/dto/create-employee.dto.ts:480` |
| B13 | Unbounded lists | BP | The activity log CSV export loads the whole audit log (time range optional). Pending attendance exceptions, labour advances, leave review, salary advances, RA/client bills, work orders and hire orders (`take:200` silently) return everything. | Require a date range and stream the export; paginate with a maximum page size. | H | `activity-log.service.ts:102`; `hire-orders.service.ts:105` |
| B14 | Activity log CSV | Sec | Values starting with `= + - @` aren't neutralised, so CSV formula injection is possible. | Prefix such cells with `'`. | M | `activity-log.controller.ts:17` |
| B15 | Defaults that bypass RLS | Sec | `PartnersService`/`ProjectsService` ref helpers default to `ctx={isSuperAdmin:true}`, and there are 110 hard-coded bypass contexts. | Make `ctx` required; keep an allow-list of system paths. | M | `partners.service.ts:62`; `projects.service.ts:960` |
| B16 | Letters / NOCs / Search | Sec | No `PermissionsGuard`; the checks in the services ignore the access level, so a **read-only** holder can upload or delete NOCs. NOC `subjectId` isn't checked. | Check write level for changes and add the guard. | M | `nocs.service.ts:232`; `letters.controller.ts:29` |
| B17 | Company selection | UX Eng | The selected company is stored per user, not per tab. Switching in one tab silently changes the company in others, so a save can land in the wrong company. | Echo the company id in responses and warn on a mismatch, or scope the selection per session. | L | `company-selection.service.ts:184` |
| B18 | Logging | BP | Prisma middleware logs every query at `log` level, including in production. | Use debug level, or turn it off in production. | L | `app.module.ts:50` |

## C. Settings and Account creation

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| C1 | Users › Edit | QA | The modal edits only `roles[0]`. Saving **removes all other roles** of a multi-role user. | Multi-select roles, or warn and make the backend add/remove explicit. | H | `settings/user-list.tsx:43`; api `users.service.ts:286` |
| C2 | Users › Edit | QA | "— No role —" sends nothing, so Save "succeeds" and nothing changes. | Remove the option, or support removing a role. | M | `user-list.tsx:52,104` |
| C3 | Users | Sec | You can delete or deactivate yourself. A company admin can delete a Super Admin in their company. | Block `id===caller.id`; require cross-company access to act on protected roles. | M | api `users-admin.service.ts:116` |
| C4 | Users | UX Eng | Access is gated by role **name** ("Super Admin", "HO User") rather than the `USER_MANAGEMENT` permission, so custom admin roles are refused. | Gate on the permission. | M | `settings/sections.ts:173` |
| C5 | Users | UX | No search, filters, sort or paging, and no Company column for a Super Admin viewing all companies. | Add them. | M | `user-list.tsx:378` |
| C6 | Companies › Modal | QA | Save is disabled on `isSubmitting`, but `mutate` isn't awaited, so double-submit is possible. | `disabled={mutation.isPending}`. | M | `company-modal.tsx:248` |
| C7 | Companies › Logo | QA | Upload refreshes a cache key nothing reads, so the **sidebar logo doesn't update** until reload (or until Save is pressed). No preview and no size check, and a logo can't be uploaded during create. | Refresh `['companies','selectable']` and the logo key; add a preview. | M | `company-modal.tsx:369`; `company-logo.tsx:70` |
| C8 | Companies list | UX | Deactivate runs in one click with no confirmation and no error handling. | Danger `confirmDialog` + an error message. | M | `company-list.tsx:38` |
| C9 | Companies | Sec | A company-scoped admin can change their company's status (deactivate it) and its `shortCode`. "Add company" is shown but always returns 403. | Make status and shortCode group-admin only; hide Add. | M | api `companies.controller.ts:363` |
| C10 | Roles | UX | Every permission is offered even if the caller can't grant it; the refusal appears only after Save. Roles are global, so the duplicate-name error reveals other companies' role names. | Disable permissions the caller can't grant; scope custom roles per company. | L | `role-modal.tsx`; api `roles.service.ts:176` |
| C11 | Approval settings | UX | Changing a level's role saves immediately with no confirmation and no holder count (a role with no holders stalls approvals). Chains are read-only in the UI although the API supports editing them. | Confirm with an impact summary and holder count; add a chain editor. | M | `approval-settings.tsx:181` |
| C12 | Billing rates | QA | 0.14 displays as `14.000000000000002`. No 0–100 check, and "abc" is sent as null. | Round the display, validate, clear "Saved" when the value changes. | M | `billing-rates-screen.tsx:45` |
| C13 | Cash visibility | QA | If loading fails, the screen shows "shown" and lets you flip the switch from a wrong state. It doesn't name the company. | Handle the error; name the target company. | M | `cash-visibility.tsx:81` |
| C14 | Signatories | QA | The file input isn't reset after adding. No edit, replace or deactivate, although the hint says replacing is possible. | Reset the input; add row actions and a thumbnail. | M | `signatories-screen.tsx:75` |
| C15 | Numbering | UX | Saving restarts the counter with no confirmation, while "Use default" does confirm. | Confirm before restarting. | L | `numbering-screen.tsx:283` |
| C16 | Personal settings / Employee setup | UX | "Personal Settings" holds a company-wide, Super Admin-only switch. The Employee setup tab isn't in the URL and has no ARIA tabpanel. | Rename the page; `?tab=`; ARIA. | L | `personal-settings/page.tsx` |
| C17 | Account creation | QA | A failed request for unlinked employees shows "Every employee already has an account." | Handle the error with Retry. | M | `create-user-form.tsx:97` |
| C18 | Account creation | UX | The employee picker is a plain select showing **only the code**, with a search that fires on every keystroke. All companies are offered to company-scoped admins. The success message mentions an email that isn't sent. | SearchableSelect with name and code; lock the company; fix the wording; share the roles cache key. | M | `create-user-form.tsx:143,227` |

## D. Approvals

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| D1 | Approval history | UX | **No month or date-range filter, no search (subject, requester, approver), no export.** Only status, "mine" and module filters exist, and the server has no from/to either. | Add `from`/`to` (or `month`), `q` and `requestedBy` to the DTO and the UI; month picker with presets; CSV export. | H | `approvals/approval-history.tsx:57`; api `approval-history-query.dto.ts` |
| D2 | Approval history | UX | Sorted by `updatedAt` and regrouped per page, so newer items can appear below older ones. A Super Admin with no company selected sees "No approvals yet". | Sort by decision date and say so; explain the no-company case. | L | api `approval-history.service.ts:98` |
| D3 | Queue | UX Eng | "Load more" puts every cursor in the query key, re-fetches all pages and blanks the list each time. | `useInfiniteQuery`. | M | `queue-table.tsx:61` |
| D4 | Queue / review | UX | Approve has no confirmation, even for Director-final steps such as payment release. Deciding doesn't refresh "upcoming". | Optional confirmation for final authority; refresh `approvalUpcoming`. | M | `action-review.tsx:155` |
| D5 | In module pages | QA *(verify)* | `ActionReview` uses `RowAction`, which hides when the user lacks write access. A chain approver with read-only module access loses Approve/Reject, although the backend authorises by chain. | `intent="read"` for approval actions. | M | `action-review.tsx`; `write-access.tsx:109` |
| D6 | Notifications | BP | Notifications are computed on the fly: no read/unread state, no email or push when an item arrives, no escalation after the age warning. | Store notification records with mark-read; send reminder emails by age. | M | api `notifications.controller.ts:26` |

## E. Dashboard, reports, activity log, reminders

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| E1 | Reports | QA | Cells are rendered with `String(cell)`, so ₹ and dates are unformatted. Row keys are `JSON.stringify(row)`, so identical rows collide. No sorting, paging or totals. After changing filters the old result stays on screen while Export uses the new filters. | Typed columns with formatting; index keys; clear the result when filters change. | M | `dashboard/report-result-table.tsx:16` |
| E2 | Reports (API) | QA | `fromDate`/`toDate` are only `@IsString`, with no from ≤ to check. | `@IsDateString` + a cross-field check, on the client as well. | L | api `run-report.dto.ts:6` |
| E3 | Activity log | UX | Presets only: no custom dates, user filter or search. Changing page blanks the list. An export error is never cleared. | Date range, user and search filters; keep previous data. | L | `activity-log-list.tsx:73` |
| E4 | Site dashboard | UX Eng | No error state (a blank page on failure). The `['sites']` cache key is shared with HR's different site list. Plain select, and choosing "Select a site…" jumps back to the first site. | Handle the error; give the key its own namespace; SearchableSelect. | M | `dashboard/site/page.tsx:26`; `site-selector.tsx:35` |
| E5 | Group dashboard | UX | Month labels use `en-US`. | Shared formatter (A18). | L | `group-cards.tsx:52` |

## F. HR and Payroll

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| F1 | Payroll engine | QA | Advance recovery is applied when a **draft** is generated. Each regeneration reduces `outstandingBalance` again, so an advance can close without being deducted. | Reverse the draft's recoveries before regenerating, or settle only at Process, keyed by run id. | C | api `payroll-engine.service.ts:332`; `salary-advances.service.ts:202` |
| F2 | Payroll engine | QA | Fuel recovery has the same double-apply on regeneration (`recordRecovered`). | Same fix. | C | `payroll-engine.service.ts:354`; `fuel-recovery.service.ts:700` |
| F3 | Payslip | QA | `deductionAdvanceRecovery` is hard-coded to 0, but net pay subtracts it, so **earnings − deductions ≠ net** on payslips. | Store `advanceRecovered` on the line item and copy it to the slip. | C | `payroll-engine.service.ts:292,676` |
| F4 | Processing | QA | `settleReimbursements` marks **every** approved payroll-mode claim as paid, including ones not in the run. | Settle only the claim ids the run included. | H | `payroll-engine.service.ts:139,754` |
| F5 | Processing | QA *(verify)* | `settleLoanSchedule` doesn't filter by company or the run's employees. A Super Admin with no company selected can mark another company's EMIs as paid. | Filter by the run's employees. | H | `payroll-engine.service.ts:704` |
| F6 | Run status | QA | A run can go processed → **paid while its approval is still pending**. `setStatus` reads status outside the transaction, so two "process" requests at once both settle. | Require an approved status; conditional update with a 409. | H | `payroll-engine.service.ts:406` |
| F7 | Run exceptions | QA | No-PAN and tax exceptions are returned once and never saved, so the amber box on run detail never appears. | Save them on the run and return them from `getRun`. | H | `payroll-engine.service.ts:391`; `payroll-run-detail.tsx:301` |
| F8 | Run detail | QA | Line-item columns don't add up to Gross or Net: conveyance, site, special, fuel and advance are missing, and gross and deductions are recomputed on the client. | Use the server's totals and add the missing columns. | H | `payroll-run-detail.tsx:42,150` |
| F9 | Run detail | UX | Register and deductions show "No rows" while loading or after a failure. No employee search, sticky header or line-item export. No way to discard a wrong draft. | Pass loading and error states; search, sticky `thead`, CSV; delete-draft with confirmation. | M | `payroll-run-detail.tsx:73,322` |
| F10 | Runs list | UX | "Generate run" over an existing draft silently replaces it, which also triggers F1/F2. | Confirm "replaces existing draft for {period}". | M | `payroll-runs-table.tsx:78` |
| F11 | Bank sheet | BP | `GET /bank-sheet` changes data (writes recoveries and history). History is capped at 100, has no month filter in the UI, and doesn't follow the selected month. | Make generate a POST and keep GET for downloads; add month filter and paging. | M | api `salary-bank-sheet.controller.ts:108`; `bank-sheet.service.ts:406` |
| F12 | Employees list | QA | The Inactive filter returns active staff (B12). Sort covers only the page, search isn't debounced, filters are lost on Back, no export. | B12 fix + A13–A15 + CSV. | H | `hr/employee-list.tsx:47` |
| F13 | Employee pickers | QA | Loans, Advances, TDS, Form 16 and the leave balance load 100 employees, including those who have left. Names for employee 101 onward show "unavailable". | Async SearchableSelect with `isActive`. | H | `loans-table.tsx:53`; `salary-advances-table.tsx:39`; `use-employee-names.ts:28` |
| F14 | Employee documents | QA | Number and expiry inputs are hidden once a document exists, so **Replace always gets a 400** for passports and licences. | Replace dialog that asks for the new number and expiry. | H | `hr/documents-tab.tsx:139`; api `employee-documents.service.ts:114` |
| F15 | Employee documents | UX | **No way to view or download** an uploaded document (no endpoint). Replace deletes the old file for good. No file name, type or size is stored. | `GET :docId/file` + View; keep versions; add metadata columns. | H | api `employee-documents.controller.ts:43`; `schema.prisma:4229` |
| F16 | Employee form | UX | First name is optional on the client but required on the server. PAN, IFSC, Aadhaar and mobile aren't checked on the client, so raw class-validator text appears, sometimes on another tab. No required markers. | Mirror the server regexes in zod and mark required fields. | M | `employee-form.tsx:83`; api `create-employee.dto.ts:56` |
| F17 | Reimbursements (admin) | UX | The approver can't open the receipt (no endpoint), and the description isn't shown. Approve has no confirmation or pending lock. No period filter or export. | Receipt view, Description column, pending lock, filter + CSV. | H | `reimbursements-admin-table.tsx:155,168` |
| F18 | Reimbursements (API) | Sec | The client can send any `receiptRef` storage key to meet the receipt threshold. Approve and pay are gated on EMPLOYEES rather than PAYROLL. | Accept only uploaded receipts; gate on PAYROLL. | M | api `claim.dto.ts:41`; `reimbursements-admin.controller.ts:38` |
| F19 | Advances / Loans | BP | No maker-checker: the creator, or the employee themselves, can approve. No amount cap. Approve, which disburses money, has no confirmation. | Block self-approval; add a cap; confirm with amount and employee. | M | api `salary-advances.service.ts:118`; `salary-advances-table.tsx:146` |
| F20 | Attendance (daily) | UX | Every employee is on one page with no search, paging or sticky header. | Search + paging. | M | `hr/attendance-table.tsx:201` |
| F21 | Monthly attendance download | UX | Sites aren't filtered by the chosen company or project and aren't reset when the company changes. | Filter and reset. | L | `monthly-attendance-download.tsx:53` |

## G. My Workspace (ESS)

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| G1 | Punch (API) | Sec | The server trusts the phone's `capturedAt` up to **72 h back**, and future times aren't refused. Changing the phone clock backdates a punch. The offline queue no longer exists. | Stamp the server receive time, or allow only a few minutes of clock skew; refuse future times. | H | api `punch.service.ts:181,247`; `config.ts:309` |
| G2 | Salary slip | QA | No Fuel recovery row, so the rows shown don't add up to the deductions total (plus F3). No error state, and its own format helpers. | Render fuel recovery; handle errors; use `format.ts`. | H | `my/salary-slip.tsx:21,232` |
| G3 | Apply leave | QA | The preview skips Saturday and Sunday, but the server uses the company's single weekly off. On 6-day weeks the preview allows applications the server then refuses. No half-day option. | Server-side day count, or fetch the weekly off and holidays. | M | `apply-leave-form.tsx:33`; api `leave-days.ts:149` |
| G4 | Leave applications | UX | Cancel has no confirmation. | `confirmDialog`. | L | `leave-applications.tsx:41` |
| G5 | Reimbursement form | UX Eng | Images only (no PDF invoices). No compression, so 12 MP photos fail on the body limit. No thumbnail. The `max` date is UTC, which blocks today before 05:30. The threshold is shown without ₹. | Accept PDFs, compress, preview, `todayIso()`, `rupees()`. | M | `reimbursement-form.tsx:47,202` |

## H. Recruitment

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| H1 | Pipeline | QA | Loads 200 candidates with no paging and no search, so candidate 201 onward is invisible. | Paging + search (the server already supports it). | H | `lib/api/recruitment.ts:238` |
| H2 | Candidate drawer | UX | Reject and No-show have no confirmation, the reason is hard-coded to "Rejected", and there's no pending lock. | Prompt for a required reason. | H | `recruitment/pipeline/page.tsx:538,664` |
| H3 | Resignations | QA | Withdraw has no confirmation and a hard-coded reason. Save has no pending lock. Changing the search keeps a hidden `employeeId`, so it can be saved against the wrong person. | Confirm; pending lock; clear the selection when it's filtered out. | M | `resignations/page.tsx:51,157,230` |
| H4 | Interviews | UX Eng | Schedule and Reschedule have no pending lock (double booking). No `min` on the date-time. Unbounded list. Interviewer names fall back to raw ids. | Pending lock, `min=now`, paging, name fallback. | M | `interviews/page.tsx:222,372`; `use-employees.ts:14` |
| H5 | Reports | UX | Funnel: no error state, date range or export. New joinings: after the first Run every date change refetches, with no loading or error state and from > to accepted. | Error, range and export; freeze params until Run. | M | `reports/funnel/page.tsx:11`; `new-joinings/page.tsx:39` |

## I. Projects and Billing

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| I1 | Project lock (API) | QA | `ProjectLockGuard` returns `true` when the route has no `:projectId`/`:id`. **Every DWR and bill-package write skips the lock**, and no service checks `isLocked`. | Resolve the project from dwrId or packageId inside the guard; add an e2e test expecting 423. | C | api `projects/guards/project-lock.guard.ts:47` |
| I2 | Project lock (API) | QA | The RA bill, client bill and work order controllers don't use the lock guard at all. Delete doesn't check the lock, and PROJECTS permission alone can unlock. | Mount the guard; give unlock its own permission. | H | api `ra-bills.controller.ts:111`; `client-bills.controller.ts:102`; `work-orders.controller.ts:71` |
| I3 | RA bill submit | QA | Drafts aren't counted toward the award, and submit doesn't re-check the ceiling. Two drafts can **exceed the award**. Approval opens before the status update, so a double-click can open two approvals. | Re-price inside submit under a row lock; conditional status update first. | H | api `ra-bills.service.ts:755,1089,1253` |
| I4 | Bill payments | QA | The over-payment check (aggregate, then insert) has no lock, so two submits at once can pay more than the certified amount. | `SELECT … FOR UPDATE` on the RA bill. | H | api `bill-payments.service.ts:146` |
| I5 | Billing rounding / GST | QA | RA bills round with floats (1.005 becomes 1.00), while packages use Decimal and round only for display, so the two policies differ and package rows may not sum to the total. The GST basis ignores the GSTIN state codes it calculates. | Decimal throughout + a "rounded off" line; warn when the state code disagrees with the CGST flag. | M | api `billing/bill-totals.ts:29`; `package/bill-tax.ts` |
| I6 | DWR list | QA | Called with no page size; the API defaults to **25**, so older reports are silently missing. No filters. | Paging + total + date and status filters. | H | `lib/api/dwr.ts:431` |
| I7 | DWR form | UX | The longest data-entry screen (a full site day) has **no unsaved-changes guard and no local draft**. A refresh or expired session loses everything. | `useUnsavedChanges` + autosave to IndexedDB keyed by project and date. | H | `projects/dwr-form.tsx` |
| I8 | DWR photos | UX | Photos show as file names only: no thumbnail, no resize, no `accept`/`capture`. Uploads run one at a time after Save with no progress and a vague failure list. The × button is about 10 px. Full-size images are stored (B6). | Thumbnails, client resize, per-file progress and retry, 44 px tap targets. | M | `dwr-form.tsx:1135,1201` |
| I9 | DWR attachments | QA | The **"Attach" button has no onClick** (only the hidden input works). Parallel uploads are possible. Open errors are swallowed. No way to delete a wrong attachment (no endpoint). | Wire the button, disable while pending, show `err.message`, add a draft-only delete. | M | `dwr-attachments.tsx:94,190` |
| I10 | DWR base64 | UX Eng | `fileToBase64` builds the string byte by byte, freezing tablets on 7 MB photos. | `FileReader.readAsDataURL`, or multipart. | L | `lib/api/dwr.ts:547` |
| I11 | BOQ caches | QA | Two BOQ cache keys: approving a DWR leaves the BOQ tree's done/pending figures stale, and an import leaves the DWR line picker stale. | One query-key factory. | M | `dwr-panel.tsx:87`; `boq-tree.tsx:78` |
| I12 | BOQ tree | UX | Up to 1,000 rows with no search, filter or export, and no sticky header or first column in a 60rem-wide table. **Any** delete error says "work has been recorded". Quantities aren't grouped. | Search, sticky `thead` and column, export, map errors by code, `quantity3()`. | M | `boq-tree.tsx:122,222,397` |
| I13 | BOQ import | QA | After a refused workbook the input isn't reset, so re-picking the fixed file does nothing. No size check. | Reset the input; check the size. | M | `boq-import.tsx:58,136` |
| I14 | RA bill sheet | QA | Quantity is a numeric state rendered into `type=number`, so typing **10.05 is impossible** (10.0 snaps to 10, then becomes 105). Raw float columns. No unsaved-changes guard. | Keep the raw string; `inputMode="decimal"`; formatter; guard. | H | `ra-bill-sheet.tsx:104,316` |
| I15 | Bill package detail | UX | "Loading the bill…" shows **forever** on 404, 403 or any error. The abstract, register and RA bill queries have no error state. | Branch on `isError`; not-found message; Retry. | M | `bill-package-detail.tsx:80` |
| I16 | Bill package lifecycle | UX | "Issue the bill" freezes all figures permanently with **no confirmation** (Abandon has one). | Confirm with net payable, bill number and missing header fields. | H | `bill-lifecycle.tsx:196` |
| I17 | Billing panels | UX | A failed fetch looks empty: "No bills yet" (bill packages), silent (RA bills), and the retention and settlement panels load forever. | Error + Retry in each. | M | `bill-packages-panel.tsx:185`; `ra-bills-panel.tsx:113`; `retention-ledger.tsx:44` |
| I18 | Compose bill package | UX | Subcontractor and work-order pickers are plain selects; "Period to" has no `min`. | SearchableSelect; `min={periodFrom}`. | L | `bill-packages-panel.tsx:245` |
| I19 | Clients modal | QA | Clearing GSTIN, PAN or State on edit sends `undefined` ("unchanged"), so **a wrong GSTIN can never be removed**. | Send `null` and allow null in the DTO. | H | `client-modal.tsx:71`; api `clients.service.ts:259` |
| I20 | Clients modal | QA *(verify)* | A blank email is sent as `""` and `@IsEmail` rejects it, so **creating a client without an email probably fails**. | `email.trim() \|\| undefined`. | H | `client-modal.tsx:63`; api `create-client.dto.ts:40` |
| I21 | Project form | QA | A query-key collision: the portfolio caches *all* clients and the form caches *active* clients under the same key, so whichever loads first decides the list. A deactivated current client empties the select and blocks Save. | Add `status` to the key; always include the current client. | M | `project-form.tsx:176,410`; `portfolio/page.tsx:59` |
| I22 | Project form / site modal / filters | UX | Clients, PM (employees) and project selects are plain and capped at 200. | SearchableSelect with server search. | M | `project-form.tsx:430`; `site-modal.tsx:144` |
| I23 | Portfolio list | UX | A filtered empty result says "No projects yet. Add one". Errors have no retry. The delete confirmation describes a cascade the API actually refuses. | Filtered-empty message with "Clear filters"; Retry; accurate wording. | L | `project-list-table.tsx:147,166` |
| I24 | Site modal | UX | Lat/long typed by hand: no "Use my location", no map preview, and no maximum radius (5,000 km is accepted). | Geolocation button, small map, `@Max(5000)` m. | L | `site-modal.tsx:109,166`; api `site.dto.ts:46` |
| I25 | Project documents | UX | No `accept`, size check or preview. No delete or replace. Client-supplied MIME is stored (B5). | Shared `<FileUpload>` (A27); supersede action. | M | `project-document-uploads.tsx:291` |
| I26 | Project lists (API) | BP | RA bills, client bills, work orders, packages and BOQ are unpaginated. | `take` cap + paging. | L | api `ra-bills.service.ts:608` |

## J. Documents, Letters and NOCs

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| J1 | Letters panel | UX | A failed fetch shows the empty message ("no letters issued"). Text-only loading. | Error + Retry, skeleton. | M | `letters/letters-panel.tsx:224,264` |
| J2 | Letter composer | UX Eng | Preview calls `window.open` after an awaited fetch, so it's **silently blocked as a popup** in Safari. Preview is available only after composing. | Use the in-page `useFileViewer`; allow a draft preview. | M | `letter-composer.tsx:113` |
| J3 | Letter issue | UX | Issuing assigns a permanent reference number with no confirmation. Long fields are single-line. | Confirm; use textareas. | L | `letter-composer.tsx:213`; `generate-letter-dialog.tsx:614` |
| J4 | Company documents | UX | No `accept`, size check, preview or progress. | `<FileUpload>` (A27). | M | `documents/document-upload.tsx:184` |

## K. Plant and Machinery

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| K1 | Fuel (API) | Sec | `siteId` isn't checked against the machine's company, so fuel can be booked to **another company's site**. | `refs.requireSiteName(caller, siteId, equipment.companyId)`. | H | api `plant/fuel/fuel.service.ts:345` |
| K2 | Logbook (API) | Sec | `projectId` isn't checked (`requireProject` exists but is unused). | Call it. | H | api `logbook.service.ts:206` |
| K3 | Hire bills (API) | QA | No overlap check, so two bills for the same machine and overlapping dates are both accepted and **both can be paid**. | Refuse when an overlapping bill that isn't cancelled exists. | H | api `hire-bills.service.ts:354` |
| K4 | Logbook (API) | QA | No future-date check and no check that the opening reading matches the previous closing reading. A typo date such as 2062 **pins the machine's meter** permanently. | Refuse future dates; warn on an opening/closing mismatch; cap hours at 24 per day. | H | api `logbook.service.ts:148,336` |
| K5 | Logbook (API) | QA | Entries can be deleted inside a verified or paid hire-bill period, and the audit log keeps only the equipment id. | Block that; store the full row in the audit log. | H | api `logbook.service.ts:295` |
| K6 | Logbook sheet | UX | "Correct them from the Logbook" points to a flow that doesn't exist: the Logbook offers only Delete, and PATCH can't change readings. | Edit-readings flow with a reason and an audit entry. | H | api `logbook-sheet.service.ts:242`; `logbook/page.tsx:177` |
| K7 | Logbook sheet | UX | Changing machine or month remounts the sheet and **discards every typed day** without asking. | Confirm when there are unsaved rows; `beforeunload`. | H | `plant/logbook/sheet/page.tsx:85` |
| K8 | Hire bills | QA | Net can go negative, and end < start is silently clamped to 0. No `min` on the to-date. The creator can verify (no maker-checker). Pay always stamps today in UTC. | Refuse these cases; block verify by the creator; add a payment-date field. | M | api `hire-bills.service.ts:441,693`; `hire-bill-modal.tsx:378` |
| K9 | Hire bills | UX | Logbook hours aren't shown before saving, so billed hours are typed blind. No period filter or export. Variance has no unit. | Fetch and prefill logbook hours; filter + export; "+12.5 h". | M | `hire-bill-modal.tsx:433`; `hire-bills/page.tsx:59` |
| K10 | Fuel | QA | 0-litre entries are accepted. No future-date check or per-fill limit. No GPS geofence (only labour and HR punches have one). | `@Min(0.001)`; refuse future dates; tank-capacity limit; capture GPS. | M | api `fuel.dto.ts:25`; `fuel.service.ts:264` |
| K11 | Maintenance (API) | QA | A closing reading below the meter still updates the schedule (`nextDueReading` = typo + interval). `closedAt` can be in the future. | Refuse, or apply the same rule to the schedule. | M | api `maintenance.service.ts:371` |
| K12 | Fuel summary / equipment cost card | UX | Shown as **loading forever** when the request fails. | Error state with Retry. | M | `plant/fuel/page.tsx:136`; `equipment/[id]/page.tsx:363` |
| K13 | Equipment documents (API) | Sec | Client MIME is stored with no allow-list (any file type). | B5. | M | api `equipment.service.ts:906` |
| K14 | Equipment | BP | No equipment photo feature: no field, gallery or thumbnail. | Primary photo + gallery using `image-fit` thumbnails. | M | api `plant/equipment/*` |
| K15 | Pickers | UX | Machines capped at 200 and operators at **100** in plain selects; there are 0 SearchableSelects in 85 plant selects. Choosing a machine overwrites a typed opening reading. No units shown. | SearchableSelect; prefill only empty fields; h/km units. | H | `use-plant-refs.ts:44`; `logbook-modal.tsx:33,119` |
| K16 | Logbook and fuel lists | UX | Raw numbers (`1234.567 litres`), no export, filters not in the URL. `type="month"` falls back to text in Safari and Firefox. | Formatters, export, URL state, month/year selects. | L | `logbook/page.tsx:86`; `fuel/page.tsx:77,128` |
| K17 | Hire orders | QA | The API silently returns at most 200 with no Pager. The route is missing from the section permission map, so the wrong error appears. | Paginate; add the route permission. | M | api `hire-orders.service.ts:105`; `plant/layout.tsx:27` |
| K18 | Disposal | QA | The client checks the date in local time and the server in UTC, so **today is rejected** before 05:30 IST. The list is unpaginated. | Company time zone on the server; paginate. | L | api `equipment-disposal.service.ts:129,433` |

## L. Assets

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| L1 | Allocations (API) | QA | The "already returned" check is outside the transaction, so two simultaneous returns **double-credit stock**. | Conditional `updateMany` with `status:'open'` inside the transaction. | M | api `allocation.service.ts:495` |
| L2 | Allocate | UX | Custodians capped at 100 in a plain select. | SearchableSelect. | H | `assets/allocate-modal.tsx:92` |
| L3 | Document modal | QA | Says "up to 10MB", but about 7.5 MB is the real limit (B4). | B4 + client size check. | M | `assets/document-modal.tsx:157` |
| L4 | Stock / summary | UX | Stock has no paging, search or export. The summary shows "Unknown project" for project 201 onward or while loading. | Pager + search; return project names from the API. | L | `assets/stock/page.tsx:30`; `summary/page.tsx:53` |

## M. Inventory

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| M1 | Purchase delete (API) | QA | Reverses `received` with no stock check, so **stock goes negative** if the material was already issued. | Lock and validate stock; refuse with 422/409. | H | api `purchases.service.ts:585-605` |
| M2 | Indent fulfilment (API) | QA | A purchase or issue can fulfil an indent line for a **different item or site**. Concurrent issues can over-fulfil. Deleting an issue after a partial return overstates fulfilment. | Check item and site; lock the line; reverse fulfilment on return. | H | api `indent-fulfilment.service.ts:35`; `issues.service.ts:409,514` |
| M3 | Transfers (API + UI) | QA | Received quantity isn't checked against sent (25 of 10 is accepted), and a shortage never adjusts stock or asks for a reason. No destination-store or date filter in the list. | Refuse received > sent; post a loss entry with a reason; add filters. | M | api `transfers.service.ts:390`; `transfer-receive-modal.tsx:36`; `transfers/page.tsx:50` |
| M4 | Issue return | QA | Two simultaneous returns double-credit stock. The quantity field means the *total returned so far*, which is confusing. | Lock the issue row; ask for "returned now". | M | api `issues.service.ts:419`; `issue-return-modal.tsx:21` |
| M5 | Pickers / masters | QA | Items, vendors, sites and store stock are capped at 200, so items past 200 **can't be picked or even edited** in Item masters. Stock search by category also drops items past 200 (wrong totals). | Server search; Pager in masters; ids-only query for category filters. | H | `use-inventory-refs.ts:23`; `masters-modal.tsx:172`; api `inventory-refs.service.ts:217` |
| M6 | Vendors in purchases / payments (API) | Sec | Accepts another company's vendor (Super Admin) and **inactive vendors**. | Check company and active. | M | api `inventory-refs.service.ts:131` |
| M7 | Raise indent | QA | Incomplete lines are **silently dropped**. Lines 2 onward have no accessible label. Duplicate items and past "Required by" dates are allowed. No units. The retired-item check is dead code. | Block submit and flag lines; aria-label; dedupe; `min`; units. | M | `indent-form.tsx:46,60` |
| M8 | Indent detail | QA | Rejected and cancelled indents still offer "Cancel indent". Reject and Cancel have no confirmation, and the error state has no retry. Requesters can approve their own indents. | Fix the condition; confirm; block self-approval. | M | `indents/[id]/page.tsx:236,250`; api `indents.service.ts:445` |
| M9 | Purchase orders | BP | POs are free-text letters with no lines and no link to GRNs, so over-receiving can't be checked. Purchases have no GST or invoice number, so the amount ≠ the bill. Stock is credited with the billed quantity, not the accepted quantity. | Structured PO lines (product decision); GST and invoice fields; credit accepted quantity. | H | `purchase-orders/page.tsx:62`; `purchase-modal.tsx:104,123` |
| M10 | Record payment | UX | Reference is required even for **Cash**. No confirmation step. A double-click creates two payments (no idempotency key). No duplicate-reference warning. | Optional reference for cash; confirmation summary; idempotency key or unique constraint. | M | `payment-modal.tsx:79`; api `payment.dto.ts:45`; `payments.service.ts:117` |
| M11 | Payment proof / bill upload | QA | No `accept` or size limit; the server's error is swallowed; the input isn't reset; proof can't be replaced. The delivery photo is stored but **can never be viewed** (no endpoint) and is orphaned on delete. | A27 + replace action; photo GET + cleanup, or drop the field. | M | `payment-proof-cell.tsx:43`; api `purchases.service.ts:152` |
| M12 | Lists | UX | Purchases, payments and issues show raw ISO dates and quantities. No totals or export. No project, vendor or slip-number filters on issues. From > To accepted. Primary submit buttons use the secondary style. Transfer status changes have no confirmation and one shared pending state. | Formatters, totals, export, filters; `Button` for primary actions. | L | `purchases/page.tsx:107`; `payments/page.tsx:55`; `issues/page.tsx:45` |
| M13 | Stock | UX | No ledger drill-down per item and store, no export, no valuation total. | Ledger page with a date range + export. | M | `stock-table.tsx:77` |
| M14 | Stock balance (API) | QA | The first purchase of an item at a site, done concurrently, can fail with P2002 (500) or lose a weighted-average-rate update. | Upsert, then `FOR UPDATE`. | L | api `stock.service.ts:53` |

## N. Partners

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| N1 | Vendor modal | QA | An error on a hidden tab (bank IFSC, contact) blocks Save with **no visible message**. | `onInvalid`: jump to the first tab with an error and badge tabs that have errors. | H | `partners/vendor-modal.tsx:149` |
| N2 | Vendor modal | UX | A lowercase GSTIN or PAN is rejected instead of upper-cased. Phone isn't checked. No GSTIN↔PAN check and no required markers. | Upper-case transform, phone check, cross-check. | L | `vendor-form-schema.ts:23` |
| N3 | Vendors | QA | Deactivating a vendor doesn't refresh the inventory vendor cache, so it can still be picked for 30 s. Edit has no pending state. Hand-rolled pager. | Refresh both keys; pending state; shared Pager. | L | `vendors/page.tsx:73,83` |
| N4 | Contractor documents | QA | Uploaded licences and insurance **can never be viewed** (no endpoint). The input isn't reset after upload. | `GET documents/:id/file` + View; reset the input. | H | api `contractors.controller.ts:44`; `contractors/[id]/page.tsx:70,212` |
| N5 | Contractor detail | QA | Registration numbers (PF, ESIC, BOCW, licence) can't be edited: `updateContractor` exists but no screen uses it. | Edit form. | M | `lib/api/partners.ts:368` |
| N6 | Compliance / RAG / BOCW | UX | No on-page filters, and no way to clear a URL filter. A RAG cell doesn't prefill the month. No export on regulator-facing reports. | Filters synced to the URL, prefill, Excel export. | M | `compliance/page.tsx:22`; `rag/page.tsx:66`; `bocw/page.tsx:90` |

## O. Labour

| # | Screen | Cat | Issue | Suggested fix | Sev | Evidence |
|---|---|---|---|---|---|---|
| O1 | Payment sheet (API) | QA | An advance is read when a sheet is generated but reduced only at disbursement, so **two sheets deduct the same instalment**. Reversal restores more than was recovered. | Reserve deductions at generation; reverse by the amount actually recovered. | C | api `payment-sheet.service.ts:531,778` |
| O2 | Payment sheet (API) | QA | A sheet **can't be deleted or regenerated**, and `reopen` doesn't recompute it. Corrections for those days are blocked forever, and the error message tells the user to delete the sheet, which isn't possible. | Draft-only DELETE or regenerate; make reopen recompute. | H | api `payment-sheet.controller.ts`; `labour-day.service.ts:117` |
| O3 | Payment sheet (API) | QA | A sheet can cover today or future dates. Later punches aren't blocked and **are never paid**. Two simultaneous generates create duplicate sheets. | `periodTo < today`; check the sheet inside the punch; advisory lock or exclusion constraint. | H | api `payment-sheet.service.ts:80,108`; `labour-punch.service.ts:228` |
| O4 | Payment sheet (API) | QA | A short-paid `carriedForwardBalance` is written but never read. Overpayment is uncapped. A legacy muster approved after the sheet is never paid. | Carry it into the next sheet; cap `paidAmount`; block approval when a sheet covers the day. | M | api `payment-sheet.service.ts:657`; `muster.service.ts:169` |
| O5 | Overnight shifts | QA | Punch-out the next day returns 409, and a correction with out < in returns 400, so night shifts can't be recorded. The correction UI also uses the browser time zone. | Attach out-punches to the latest open in-punch (within about 16 h); support `punchOutNextDay`; use IST. | M | api `labour-punch.service.ts:228,418`; `muster-attendance.service.ts:434`; `muster-attendance/page.tsx:668` |
| O6 | Day rules modal | QA | If opened before the rules load, it shows the 8/4/8 defaults and **Save overwrites the company's rules**. | Disable Save until the rules have loaded. | H | `labour/muster-attendance/page.tsx:149,270` |
| O7 | Muster attendance | QA | "Monthly Excel" in the daily view exports the hidden month, not the viewed date's month. No name or code search. | Use `date.slice(0,7)`; add search. | M | `muster-attendance/page.tsx:114,437` |
| O8 | Muster detail / reports / advances | UX | Workers, supervisors, sites and contractors show as **raw UUIDs**. Reports have no loading or error states and no export, and refetch on every filter change. | Return names from the API; standard states; freeze params until Run. | H | `musters/[id]/page.tsx:30`; `reports/attendance/page.tsx:20`; `advances/page.tsx:46` |
| O9 | Payment sheet detail | QA | Reverse and Reopen have no confirmation and send hard-coded reasons. Disburse has no pending lock and no 0 < amount ≤ net check. The list isn't refreshed. | Prompt for a reason; validate; pending lock; refresh the list. | H | `payment-sheets/[id]/page.tsx:182,371,431` |
| O10 | Generate sheet | UX | The help text still describes the old punch-in-only half-day rule, not the hours-based rules (034). | Rewrite it from the day rules. | M | `payment-sheets/page.tsx:210` |
| O11 | Workers | QA | Loaded with pageSize 200 and no pager, so workers past 200 disappear. Search isn't debounced. A future last working day is accepted. | Server paging; debounce; `max=today`. | H | `labour/workers/page.tsx:62,313` |
| O12 | Advances | QA | Approve and Disburse have no confirmation and share one mutation. Save has no pending lock. Worker select capped at 200. Instalments of 0 or 2.5 pass. A requester can approve their own advance. | Confirm; per-row pending; SearchableSelect; integer ≥ 1; block self-approval. | H | `advances/page.tsx:110,149`; api `labour-advance.service.ts` |
| O13 | Gangs / wage rates | QA | Save ignores `isPending` (duplicates). Deleting a skill category asks "Delete this wage rate?". Negative rates pass. Query keys don't include the company. | Pending lock; fix the wording; rate > 0; add the company to the key. | M | `gangs/page.tsx:142`; `wage-rates/page.tsx:40,220` |
| O14 | Site and worker refs (API) | Sec | For Super Admin or `LABOUR_APPROVE` holders, the site and worker aren't checked against the company. `LabourWorker.siteId` has no foreign key. | Compare the company explicitly. | L | api `labour-worker.service.ts:238`; `labour-advance.service.ts:156` |
| O15 | Phone modals | UX Eng | Footer buttons are wrapped in a `div`, which defeats the full-width stacked layout on phones. | Pass the buttons directly. | L | `workers/page.tsx:273`; `modal.tsx:108` |

---

## Top 10 highest-impact fixes

1. **Payroll recovery and payslip integrity (F1–F4, F6, G2):** regenerating a draft drains advances and fuel recoveries; payslips don't add up; claims that weren't in the run are marked paid; a run can be marked paid without approval. This is money and statutory paperwork.
2. **Labour payment sheet integrity (O1–O4):** advances are deducted twice across sheets; sheets can't be deleted or regenerated; punches after a sheet's period are never paid.
3. **Project lock bypass (I1, I2):** a locked project still accepts DWR, bill-package, RA bill and work order writes.
4. **Invite and set-password rate limit not enforced (B1),** plus the wider hardening gaps (helmet, CORS fallback, global throttle; B9).
5. **Super Admin "selected company" bugs (B2, B3):** approval actions disappear, and the activity log, reminders, site list, report export and Employee Setup break.
6. **Over-billing and over-payment races (I3, I4, K3, M1):** RA bill drafts can exceed the award, bill payments can exceed the certified amount, hire bills can overlap, and deleting a purchase can make stock negative.
7. **Truncated pickers and lists (A11, A12, F13, H1, I6, K15, M5, O11):** records past 100, 200 or 25 silently vanish. One shared async SearchableSelect fixes most of it.
8. **Upload pipeline (B4–B6, A27):** the "10 MB" limit is really about 7.5 MB, there's no type allow-list, images aren't compressed, and there are no previews. Several documents can't be viewed at all (F15, N4, F17, M11).
9. **Error and feedback foundation (A1–A5):** error boundaries, fetch timeout and network errors, readable validation messages, a shared ErrorState with Retry, and no false "Access denied".
10. **Approval History filters (D1),** plus the approver-visibility fix (D5) and double-submit locks on every money or approval action (A7).

## Quick wins (under 30 minutes each)

- B1: register `ThrottlerGuard` as `APP_GUARD`.
- B12: fix the boolean `@Transform`, which makes the employee Inactive filter work again (5 DTOs).
- A6: set `intent="read"` on 6 buttons so read-only users can run reports and download letters.
- A19: replace `toISOString().slice(0,10)` with `todayIso()` (34 sites) and fix `currentPeriod()`.
- A25: add `.catch()` on `refreshInFlight`. A30: move `themeColor` to `viewport`. A31: ignore `.claude/**` in ESLint.
- C12: round the billing-rate display. E5 and A18: one shared date formatter set to DD-MM-YYYY.
- I9: wire the DWR "Attach" button. O10: fix the payment-sheet help text. O13: fix the "Delete this wage rate?" wording.
- I19 and I20: send `null`/`undefined` correctly in the client modal.
- I11 and I21: unify the BOQ and client query keys.
- K1 and K2: call the existing `requireSiteName`/`requireProject` helpers.
- K10: `@Min(0.001)` on fuel quantity. M10: make the reference optional for cash payments.
- M8: fix the indent Cancel condition. O6: disable Save until the day rules load. O7: export the correct month.
- Reset file inputs after upload or error (C14, N4, M11, I13).
- Add `disabled={isPending}` to the 33 unguarded action buttons (A7).
- Add `ThrottlerGuard` and `PermissionsGuard` to the Letters and NOCs controllers (B16).

## Broken flows and bugs (steps to reproduce)

**Money and data integrity**

1. **Draft payroll regeneration drains advances (F1).**
   1. Create an advance of ₹10,000 for employee E, recovered in period P, and approve it.
   2. Generate the run for P. The balance drops by the amount deducted.
   3. Generate again. The balance drops again and the advance can close, even though E repaid less.
2. **Payslip doesn't balance (F3).**
   1. Do 1.1–1.2, then Process the run.
   2. Open /my/salary for P. Advance recovery shows ₹0, but net pay is reduced, so earnings − deductions ≠ net.
3. **Claims marked paid without payment (F4).**
   1. Generate the draft.
   2. Approve a payroll-mode claim.
   3. Process without regenerating. The claim is marked `paid`, but no line item includes it.
4. **Run marked paid before approval (F6).**
   1. Process a run. Its approval is pending.
   2. Click "Mark as paid". The server accepts it.
5. **Labour advance double deduction (O1).**
   1. Disburse an advance of ₹1,000 in one instalment.
   2. Generate the sheet for 1–7 Sep. It deducts 1,000.
   3. Generate the sheet for 8–14 Sep before disbursing the first. It deducts 1,000 again.
   4. Disburse both. The worker loses ₹2,000.
6. **Payment sheet locks days forever (O2).**
   1. Generate a draft sheet for 1–7 Oct.
   2. Try to correct a punch on 3 Oct. You get 409, and no endpoint can delete or recompute the sheet.
7. **Same-day sheet loses pay (O3).**
   1. At 11:00, generate a sheet ending today.
   2. Workers punch out at 18:00. That attendance is never on any sheet, and a new sheet is refused because it overlaps.
8. **RA bill exceeds the award (I3).**
   1. Award a line of 100 m³.
   2. Create draft A for 100 and draft B for 100. Both pass.
   3. Submit both. 200 m³ goes for approval.
9. **Overlapping hire bills (K3).** Create two bills for the same machine, 1–31 Oct and 15 Oct–14 Nov. Both are accepted and both can be paid.
10. **Negative stock (M1).**
    1. Purchase 100 bags at Store A.
    2. Issue 80.
    3. Delete the purchase. Stock shows −80.
11. **Indent fulfilled by the wrong item (M2).** Purchase steel at site B with a cement indent line id from site A. The cement line shows fulfilled.

**Security and access**

12. **Locked project still writable (I1).**
    1. Lock P.
    2. Send `PATCH /projects/dwr/<dwrId of P>` or `POST /projects/bill-packages/<pkg>/issue`. It succeeds instead of returning 423.
13. **Invite throttle (B1).** Send 25 × `GET /account-creation/invites/abc`. All 25 return 200; expected 10 returning 200, then 429. *(Reproduced.)*
14. **Fuel on another company's site (K1).** Send `POST /plant/fuel` with company A's machine and company B's `siteId`. It is accepted.
15. **Selected company ignored (B2, B3).**
    1. As a Super Admin whose home company is A, select company B.
    2. Open the Site dashboard: "No sites yet".
    3. Open the Activity log: empty or company A's data.
    4. Open a work order: no Approve/Reject.
    5. Go to Employee setup › Add department: 500.
16. **Backdated punch (G1).** Set the phone clock 2 hours back and punch in. The punch is stored 2 hours earlier and accepted.

**Broken UI flows**

17. **Multi-role user loses roles (C1).**
    1. A user has roles A and B.
    2. Open Edit; the modal shows only A.
    3. Pick C and save. A and B are deleted.
18. **The Inactive employee filter shows active staff (B12).** HR › Employees › Status: Inactive. The request sends `isActive=false`, the server reads `true`, and active employees are returned.
19. **Document Replace always fails (F14).** On an employee with a passport on file, click Replace and pick a file. You get 400 "Passport requires an expiry date".
20. **Uploads of 8–10 MB fail with a raw 413 (B4).** Upload a 9 MB PDF on equipment, NOC, asset or DWR. You get "request entity too large". *(Reproduced.)*
21. **Records past 100 or 200 vanish (A12).** With more than 100 employees, open Loans › New. Employee 101 onward is missing. The same happens for items, vendors and machines past 200, and DWRs past 25.
22. **Read-only labour user can't run reports (A6).** Open Labour › Reports › Attendance. There's no Run button.
23. **A /me failure locks the user out (A5).** Go offline and navigate. You get "Access denied" with no Retry, until a hard reload.
24. **Escape closes the wrong layer (A8).** In Item masters, click Delete on a category so the confirmation opens, then press Esc. The masters modal closes and the confirmation stays.
25. **Day rules overwritten (O6).** On a slow connection, open Day rules immediately and click Save. The rules are reset to 8/4/8.
26. **Logbook sheet data loss (K7).** Type 10 days of readings, then change the machine. Everything is gone without a prompt.
27. **Typo date pins the meter (K4).** Record a logbook day dated 2062 with closing reading 99999. The machine's meter stays at 99999 permanently.
28. **RA bill decimal entry (I14).** Type 10.05 in "This period". It becomes 105.
29. **Bill package hangs (I15).** Open a bill package with a bad id. "Loading the bill…" shows forever.
30. **Vendor Save silently blocked (N1).**
    1. Type an invalid IFSC on the Bank tab.
    2. Return to Details and click Save. Nothing happens.
31. **Indent lines dropped (M7).** Line 2 has an item but no quantity. Submit; the indent is created without line 2.
32. **Wrong default date before 05:30 IST (A19).** At 01:00, open Fuel, Issue or Purchase. The date shows yesterday. Disposal rejects today's date (K18).
33. **Client GSTIN can't be cleared (I19).** Edit a client, clear the GSTIN, save. The GSTIN stays.
34. **Client without an email (I20) *(verify)*.** Add a client with only a name. You probably get 400.
35. **Logo doesn't refresh (C7).** Upload a logo, then click Cancel. The sidebar shows the old logo until reload.

## Suggested order of implementation

1. **Money and data-integrity hotfixes (backend first, each with a regression test):**
   - Payroll: F1–F8, G2.
   - Labour: O1–O5.
   - Billing and payments: I3, I4, K3, M1, M2, M4, L1.
   - Payroll and inventory races: F6 race, M10 idempotency.
2. **Security and access:**
   - Throttling and hardening: B1, B8, B9.
   - Project lock: I1, I2.
   - Selected company: B2, B3.
   - Company and site checks: K1, K2, M6, O14, F5.
   - Punch time and upload types: G1, B5.
   - Permission gaps: B16, C3, C9, F18, F19 maker-checker.
   - DTO fixes: B11, B12.
3. **Frontend foundation (unblocks most per-screen rows):**
   - Errors and retry: A1–A5 (error boundaries, `apiFetch` timeout and normalisation, QueryError + retry policy, module-guard error state).
   - Buttons and modals: A6, A7 (Button intent and loading), A8–A10 (modal stack, dirty guard).
   - Feedback: A17 (toasts).
   - Formats: A18–A20 (one date, currency and quantity module, `todayIso`).
4. **Shared list and picker kit:**
   - Async `SearchableSelect` with server search, replacing every capped picker (A11, A12, F13, K15, L2, M5, O11, I22, C18).
   - `useUrlState`, debounce, `keepPreviousData` and server sort for `ResponsiveList`/`DataTable` (A13–A16).
   - Paging where it's missing: H1, I6, B13, K17.
5. **Upload pipeline:**
   - Shared `<FileUpload>` with client compression, preview, size and type checks, and progress (A27).
   - Server-side: route-scoped body limit or multipart (B4), compression and thumbnails (B6), cache headers (B7).
   - Missing view and download endpoints: F15, N4, F17, M11; delete or replace for I9, I25.
6. **Approvals and reports:** D1–D6, E1–E4, F11, O8 (show names, not UUIDs), H5, N6 exports.
7. **Per-module UX polish:**
   - Confirmations on destructive or irreversible actions: I16, J3, C8, C15, H2, H3, M8, O9, O12, F19.
   - Required markers, inline validation, and Esc/dirty handling per form: F16, M7, N1, N2.
   - Module-specific items in the tables above.
8. **Design-system consolidation and accessibility:** A21–A23, A28, A29, tooling A31. Do this last, so it doesn't conflict with the functional changes above.

**Product decisions needed before building:**
- M9: structured purchase orders with GST on purchases.
- K10: GPS geofence for fuel entries.
- K14: an equipment photo gallery.
- D6: stored notifications with reminder emails.
- B17: company selection per tab or per user.
