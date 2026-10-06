# Implementation Plan: Projects Flow Completion

**Branch**: `004-dashboard-backend` (api) / `004-dashboard` (web) | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/025-projects-flow-completion/spec.md`

## Summary

Ninety endpoints exist under the projects module. A user walked the journey they serve and could not
save the first screen. This feature closes the seam: it realigns one client module to a contract it
never read, adds **one** endpoint, adds **two** configuration surfaces for columns that already
exist, and places screens over twelve endpoints that have been passing their tests with no caller.

**The headline finding, verified before planning: this feature ships no migration.** Every column it
touches is already in the schema:

| What the feature needs | Where it already is |
|---|---|
| `startDate`, `finishDate`, `duration`, `perDayQty` | `projects.BoqItem` — read by `viewOf()` and `neededRate()` today |
| `clientRetentionFraction` | `projects.Project`, schema.prisma line 1692 |
| `cgstFraction`, `sgstFraction`, `igstFraction`, `tdsFraction` | `settings.Company`, lines 451-455, beside `bocwCessRate` |
| `createdByUserId`, `submittedByUserId` | `projects.DailyWorkReport` lines 42-43 — selected by the detail read, not by the list |
| An audit type for a rate change | `AuditEntityType.COMPANY`, in use by feature 002 |

No new table means the constitution's RLS-probe obligation has nothing to attach to, and the
generated-migration rule has nothing to govern. Both gates below pass **because there is nothing to
gate** - stated with evidence rather than ticked.

## Technical Context

**Language/Version**: TypeScript 5, Node 20. NestJS 10 (api), Next.js 15 app router (web).

**Primary Dependencies**: Prisma 5.22 multiSchema, class-validator + class-transformer, zod (web),
TanStack Query (web), Tailwind (web). **No dependency is added by this feature.**

**Storage**: PostgreSQL. **No schema change** - see Summary.

**Testing**: Jest + ts-jest for unit, `test/*.e2e-spec.ts` for end-to-end, in buildcore-api.
**buildcore-web has no test runner at all** - `package.json` carries `build`, `dev`, `start` and
`lint`, and no jest, vitest or testing-library dependency. This is load-bearing for Phase B.

**Target Platform**: Linux server behind the existing auth and RLS stack; modern browsers.

**Project Type**: Two repositories, one journey. The defect that prompted the feature is precisely
the seam between them.

**Constraints**: The global validation pipe runs at `whitelist: true` + `forbidNonWhitelisted: true`
(src/common/configure-app.ts line 34) - which is *why* the web's invented `nos` and `factor` fields
are a **400** rather than a silent strip. Decimals are `Prisma.Decimal` and cross the wire as
strings. Writes run inside `withRlsContext`, maxWait 2000ms / timeout 5000ms.

**Scale/Scope**: 38 requirements. One new endpoint, two DTO fields, two select additions, one
settings surface, fourteen web surfaces, five corrections. Roughly 85% of the work is wiring.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Both passes identical - no
design decision below moved a gate.*

| Principle | Verdict | Evidence |
|---|---|---|
| **I - Multi-tenant isolation** | **PASS, nothing to gate** | No new table. Every table touched already carries `tenant_isolation`; `BoqItem` and `Project` are proven by 008's probe, `Company` by 002's, `DailyWorkReport` by 022's. The new PATCH route reads and writes through `withRlsContext` like its siblings, so it inherits the policy rather than needing one. **No new probe suite is owed, and the plan says so rather than quietly omitting it.** |
| **II - Validated DTO contracts** | **PASS** | The PATCH reuses `CreateBoqItemDto`'s four already-validated programme fields (FR-010) rather than declaring a second shape. The retention term reuses `WorkOrderDto.retentionPercent`'s exact constraints. The tax rates get their own bounded DTO - the only genuinely new one. |
| **III - Schema-per-module boundaries** | **PASS** | The tax rates live on `settings.Company` and are reached through the settings module, which already owns `bocwCessRate` beside them; the billing module keeps reading them through `CompaniesService.getBillingTaxRates`, which exists. No module reaches across. |
| **IV - No hardcoded values** | **PASS, and this is the principle the feature serves** | FR-016 to FR-024 exist *because* of it: a retention term and four statutory rates were in the schema with no way to set them, which is a hardcoded value wearing a column's clothes. |
| **V - Safe additive migrations** | **PASS, nothing to gate** | No migration. Verified column by column in the Summary table. |
| **Development Workflow - generated migrations only** | **PASS, nothing to gate** | Same. |
| **Technology stack - exceljs for .xlsx** | **PASS** | Untouched. The measurement-sheet screen (FR-028) reads the existing JSON endpoint, not the workbook. |

**No Complexity Tracking table is required** - no gate is violated and no deviation is taken.

## Project Structure

### Documentation (this feature)

```text
specs/025-projects-flow-completion/
├── plan.md              # This file
├── research.md          # Phase 0: six decisions, each with what was rejected
├── data-model.md        # Phase 1: the no-change statement, with the audit behind it
├── quickstart.md        # Phase 1: six validation passes
├── contracts/
│   └── projects-flow-api.md   # The delta only: one new route, three changed payloads
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 - not created here
```

### Source code

```text
buildcore-api/
├── src/projects/boq/
│   ├── boq.controller.ts          # + PATCH items/:itemId   (the ONE new route)
│   ├── boq.service.ts             # + planItem()
│   └── dto/boq.dto.ts             # + PlanBoqItemDto (reuses the four existing fields)
├── src/projects/portfolio/
│   └── dto/                       # + clientRetentionFraction on create and update
├── src/projects/dwr/
│   └── dwr.service.ts             # list() select grows two columns that already exist
├── src/settings/companies/
│   ├── companies.controller.ts    # + read/write the four statutory rates
│   └── companies.service.ts       # extends getBillingTaxRates' neighbourhood
└── test/
    ├── boq-planning.e2e-spec.ts   # new
    ├── bill-package.e2e-spec.ts   # + FR-038 permission refusal, + retention round trip
    └── dwr.e2e-spec.ts            # + FR-008 exact-wire-shape assertions

buildcore-web/
├── app/lib/api/dwr.ts             # REALIGNED to the contract - Phase A
├── app/lib/api/projects.ts        # + the four programme fields on patch, + retention
├── app/lib/api/settings.ts        # + the four tax rates
├── app/ui/projects/
│   ├── dwr-panel.tsx, dwr-form.tsx            # follow Phase A
│   ├── boq-tree.tsx, boq-entry.tsx            # inline programme edit, + start date
│   ├── project-form.tsx                       # + retention percent
│   └── ...                                    # Phase E's surfaces
└── app/dashboard/projects/        # Phase E's routes
```

**Structure Decision**: Both repositories, no new top-level directory in either. Every file above
exists except the three named *new*.

## Phases

Each phase is independently committable, and the order is a dependency order: Phase A is the
reported bug and owes nothing to the rest; Phase C's web half needs Phase C's endpoint; Phase E
needs nothing but is last because it is the largest and the least risky.

### Phase A - the daily-work contract (web only; the reported defect)

Realign `app/lib/api/dwr.ts` to `specs/022-daily-work-reports-backend/contracts/dwr-api.md` and to
what `DwrService` actually returns. Four corrections, each of which is currently a defect:

1. `dprNumber`, never `reportNumber` (FR-001). The latter exists nowhere in the system.
2. The creation response is `{ id, dprNumber, status, warnings }` - demanding `projectId` and
   `workDate` back from it rejects every successful save (FR-002).
3. A warning is `{ code, message, detail? }` (FR-003), rendered beside the success (FR-004).
4. The list is a page of summaries carrying `lineCount` - **no** lines array (FR-005).

Then `dwr-form.tsx`: `nos` to `nos1`, `factor` to `nos2`, in the payload **and** in
`previewMeasuredQuantity`'s key list, which today multiplies two keys the server has never heard of
(FR-007, FR-007a). Labels unchanged, per the user's decision.

**Two judgements, both recorded in research.md sections 1 and 2**: the list grows the two author
columns on the server rather than the control dropping its rule; and the Lines column becomes a
count.

### Phase B - the divergence check (FR-008)

**Constrained by a fact found during planning**: buildcore-web has no test runner. Adding jest or
vitest plus config plus CI for a single assertion is a new permanent surface for one check, and is
rejected - see research.md section 3 for what is built instead and, more usefully, for what it
cannot catch. No automated check will span the two repositories in this feature, and the plan says
so plainly rather than implying a safety that does not exist.

### Phase C - planning a schedule line (the one new endpoint)

`PATCH projects/:id/boq/items/:itemId` carrying only the four programme fields. Reuses
`CreateBoqItemDto`'s validated field definitions (FR-010); `null` clears and omission leaves alone
(FR-011, research.md section 4 for why `@IsOptional()` expresses this without a custom validator);
validation of the programme's internal consistency happens against the **merged** result, not the
request, because a PATCH setting only a finish date must still be refused against the stored start
date (FR-012). `Permission.PROJECTS`, `ProjectLockGuard`, 404-not-403 - copied from the sibling
`DELETE items/:itemId` rather than reasoned afresh (FR-013). Scope, rate, unit and description are
not accepted at all, so FR-015 is a property of the DTO rather than a check in the service.

**Route shadowing**: the controller is `@Controller('projects/:id/boq')` and the new route is
`items/:itemId`, the same literal segment the existing DELETE uses. Nothing new is shadowed, and
`src/projects/route-shadowing.spec.ts` continues to prove it.

Web half: inline programme edit on `boq-tree.tsx`, and the start date missing from `boq-entry.tsx`
without which the *Avg / day* column can never populate (FR-014).

### Phase D - the two configuration gaps

`clientRetentionFraction` joins the create and update project DTOs with
`WorkOrderDto.retentionPercent`'s exact constraints - a fraction, bounded `[0, 1]`, six decimal
places - because the same composer reads both and two conventions is how they come to disagree
(FR-016 to FR-020, research.md section 5). The web divides by 100 at the form, as `bill-sheet.tsx`
already does for the subcontract term.

The four statutory rates become readable and writable through the settings module, audited under
`AuditEntityType.COMPANY` (FR-021, FR-022, FR-024). **FR-023 is asserted, not assumed**: a test
changes a rate between issuing a package and re-reading it, and demands the issued figures are
unchanged.

### Phase E - reachability (fourteen surfaces, no service written)

Every item below calls an endpoint that exists today. **If a task in this phase creates a service, a
DTO or a table, the task has been misread.**

| Surface | Endpoint it calls | What it reuses |
|---|---|---|
| DWR attachments | `POST projects/dwr/:id/attachments`, `GET projects/dwr/attachments/:id` | the upload pattern in `project-document-uploads.tsx`, `download-file.ts` |
| Draft edit / delete | `PATCH projects/dwr/:id`, `DELETE projects/dwr/:id` | `dwr-form.tsx` in an edit mode |
| Reconciliation + repair | `GET /dwr/reconciliation`, `POST /dwr/reconciliation/repair` | table + confirm, `SectionGuard` |
| Measurement sheet | `GET bill-packages/:id/measurement/:lineId` | `getMeasurementSheet`, already written and unused |
| Debit raise + apply | `POST bill-package-debits`, `POST .../apply/:packageId` | `recordDebit` / `applyDebit`, already written and unused |
| Revise / abandon | `POST .../revise`, `POST .../abandon` | `reviseBillPackage` / `abandonBillPackage`, already written and unused |
| Understatement / over-claims | the two report routes | `getUnderstatementReport` / `getOverClaimReport`, already written and unused |
| Work-order edit | `PATCH projects/work-orders/:id` | `updateWorkOrder`, already written and unused |
| Retention release | `GET/POST projects/ra-bills/retention/:workOrderId` | needs a thin wrapper; the routes exist |
| Estimate import | `POST .../estimate-import/validate` and `/confirm` | `boq-import.tsx` with a different endpoint |
| Project letters | the existing letters routes | the recruitment letters screens |

**Twelve of these already have a written, tested, unused client function.** The audit found them by
name. Phase E is mostly deleting the word "unused".

### Phase F - the corrections

FR-035 (a punch at an inactive site), FR-036 (the costing breakdown reconciles or states its basis),
FR-037 (a requirement citing a function that does not exist - documentation only, no code), FR-038
(the permission refusal nothing asserts), and ticking 023's T100/T101 and 008's T057/T058/T059.

## Test Strategy

Planned here rather than left to tasks, because three of these are the feature's only defence
against a failure that looks like success.

| Test | What it proves | How it could pass vacuously, and what stops that |
|---|---|---|
| Exact wire shape of the create and list responses | The contract's promise, asserted on the wire | An assertion that the response *contains* `dprNumber` passes just as happily on a response containing everything. **Asserted as an exact sorted key list**, so an added or removed field fails. |
| Programme round trip | A line that read *Not planned* reports figures afterwards | Asserting the PATCH returns 200 proves nothing about the read. **The GET is re-read and the three columns asserted non-null**, and a second case asserts an explicit clear returns them to null while an omission does not. |
| `to_client` composition | That half of feature 023 is reachable at all | A test that only composes *with* the term never proves the refusal still works. **Both halves asserted**: refused by error code without the term, accepted with it. |
| Issued bill unchanged across a rate change | FR-023's freeze | A test that changes a rate and re-reads a *draft* proves the opposite of what is wanted. **The package is issued first**, then the rate changed, then the issued figures re-read. |
| `PROJECT_FINANCIALS` refusal | FR-038 | A test using a token with no permissions at all would also pass against a route guarded by nothing. **The caller holds other permissions and lacks only this one.** |

Every new e2e suite closes its Nest app and disconnects any `PrismaClient` it constructs, or
`src/common/prisma/e2e-teardown.spec.ts` names the file.

## Risks

1. **Phase A changes a shared module.** `app/lib/api/dwr.ts` has five consumers; a rename that
   misses one is a type error, which is the good case, and a `.passthrough()` that swallows it is
   the bad one. The realignment removes passthrough from the response schemas it narrows.
2. **The DWR list growing two fields is an API change.** Additive and backward compatible, but the
   published contract must move with it in the same commit or this feature reproduces its own bug.
3. **Phase E is fourteen surfaces.** The risk is not difficulty but drift: fourteen chances to
   invent a rule the server already enforces. The per-surface endpoint table above is the control.
