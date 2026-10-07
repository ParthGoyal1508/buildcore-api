# Implementation Plan: Projects defect register

**Branch**: `004-dashboard-backend` (continuing) | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/028-projects-defect-register/spec.md`

---

## Summary

Thirty requirements across two repositories, closing the client's 6 October list. Seven phases, each independently committable, ordered by severity rather than by module: the bill that cannot be composed first, then the document that understates a deduction, then the two approval subjects that share one mechanism, then the rate contract, then money and paper, then daily work, then the screens that already hold their data.

**The one thing to read before planning anything else**: this feature is not 025. It ships **three new tables, a moved unique constraint, a new enum value and a new approval action** — so the constitution's RLS-probe obligation bites three times and the generated-migration rule governs every schema touch. That is stated in the gate table as a condition to satisfy, not as a formality passed by having nothing to gate.

---

## Technical Context

**Language/Version**: TypeScript 5, Node 22
**Primary Dependencies**: NestJS 10, Prisma 5.22 (multiSchema), class-validator + class-transformer under a global pipe at `whitelist` + `forbidNonWhitelisted`, `exceljs`, `pdfkit`, `@aws-sdk/client-s3` via `StorageService`
**Storage**: PostgreSQL, schema-per-module, row-level security keyed on company
**Testing**: Jest + ts-jest; `*.spec.ts` colocated, `test/*.e2e-spec.ts` against **`buildcore_scratch` only**
**Target Platform**: Linux server; companion web app is Next.js 15 app router with zod at the API boundary, TanStack Query, Tailwind
**Project Type**: Web — `buildcore-api` and `buildcore-web`, planned together, committed separately
**Performance Goals**: No change to any existing budget. The rate lookup in Phase D is on the purchase write path and must stay one query, not one per line.
**Constraints**: Decimals cross the wire as strings. `buildcore-web` has **no prettier config and must never be formatted**. `buildcore-api` has `.prettierrc.json` and prettier is run.
**Scale/Scope**: 30 functional requirements, 7 phases, 3 new tables, ~9 commits.

### Unknowns

None. All twenty decisions were settled with the user before the spec was written; `research.md` records the six that needed reasoning rather than a preference.

---

## Constitution Check

Constitution v1.5.0.

| Principle                               | Verdict                          | Evidence                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I. Schema-per-module boundaries**     | **PASSES, with work**            | The agreed rate belongs to `inventory` beside `Purchase` and `Item`; it references `partners.Vendor` by **plain id with no relation**, exactly as `Purchase.vendorId` already does. The bill payment belongs to `projects`. Neither crosses a schema with a foreign key.                                                                                         |
| **II. Validated DTO contracts**         | **PASSES, with work**            | Every new route carries a validated DTO. FR-013 is explicit that the DTO is **not sufficient** — the immutable rate is enforced in the service, because a DTO can require a number and only a service can require *this* number. _Amended 2026-10-07_: the original wording justified this by saying `PATCH /purchases/:id` accepts a rate from any caller, which was asserted without reading the DTO and is false — see research §5.                                                                               |
| **III. No hardcoded values**            | **PASSES, with work**            | The debit-note series goes through `CodeSeriesService` like every other number. No rate, percentage or threshold is written into code: FR-009 and FR-010 ship **no** value threshold precisely so that none is hardcoded ahead of a decision.                                                                                                                    |
| **IV. Multi-tenant isolation**          | **GATE — three probes required** | **Three new tables.** Each needs an RLS probe before its phase can be committed: the agreed rate (Phase D), the bill payment (Phase E), and the signed-copy record (Phase E). This gate does **not** pass by inspection; it passes when `test/rls-*.e2e-spec.ts` proves a second company cannot read the rows.                                                   |
| **V. Auth & secrets**                   | **PASSES**                       | Every new route reuses the permission its siblings carry. Signed copies go through `StorageService`, which already holds the encrypted-reference pattern; no file path or bucket name is exposed to a caller.                                                                                                                                                    |
| **VI. Observability & safe migrations** | **GATE — generated only**        | Six schema touches. Every migration is produced by `prisma migrate diff --from-schema-datasource --to-schema-datamodel --script` (not `npm run migrate:dev:create`, which is non-interactive here) and **never hand-edited**. The nine pre-existing index-name drifts are excluded from each generated file; a migration containing them has been mis-generated. |

**Approved dependencies used, none added**: `pdfkit` (constitution line 183) for the debit note, `exceljs` (line 187) for the daily-report workbook, `@aws-sdk/client-s3` via `StorageService` (line 222) for signed copies. Phase E reuses `bill-pdf.renderer.ts` and Phase F the workbook renderer's pattern — **no second renderer is written**.

### Post-design re-evaluation

Unchanged. The three RLS probes and the six generated migrations remain the only conditions, and they are tasks in `tasks.md` rather than reminders.

---

## Project Structure

### Documentation (this feature)

```
specs/028-projects-defect-register/
├── spec.md
├── plan.md              # this file
├── research.md          # the six decisions that needed reasoning
├── data-model.md        # three new tables, three altered
├── contracts/
│   └── projects-defect-api.md
├── quickstart.md        # seven passes, one per phase
└── checklists/
    └── requirements.md
```

### Source Code

```
buildcore-api/src/
├── projects/
│   ├── billing/
│   │   ├── ra-bills.service.ts          # A: require a work order; B: retire three fields
│   │   ├── payments/                    # E: NEW — bill payments
│   │   └── package/
│   │       ├── bill-package.service.ts  # A: P2002 → 409; C: refuse an unapproved award
│   │       └── debit-note.service.ts    # E: number at raise; standalone PDF
│   ├── dwr/
│   │   ├── dwr.service.ts               # F: author names
│   │   ├── dwr-workbook.renderer.ts     # F: NEW — the client's form
│   │   └── dto/                         # F: weather out
│   └── documents/                       # E: signed copies, on the DWR attachment pattern
├── inventory/
│   ├── rates/                           # D: NEW — the vendor–item agreed rate
│   └── purchases/purchases.service.ts   # D: supply and freeze the rate
└── approvals/default-chains.ts          # C: two new actions

buildcore-web/app/
├── ui/projects/
│   ├── bill-packages-panel.tsx          # G: subcontractor before work order
│   ├── ra-bill-sheet.tsx                # B: three fields removed
│   └── bill-sheet.tsx                   # B: the correction route
├── dashboard/projects/portfolio/[id]/
│   ├── layout.tsx                       # G: the company-switch 404, handled once
│   └── page.tsx                         # G: Commercial terms
└── ui/inventory/                        # D: the rate, read-only; G: the Issue label
```

**Structure decision**: Option 2 (web application). Each phase is one API commit and at most one web commit; the two halves of a phase ship together only where a response shape changes, which is Phases B, D, E and F.

---

## Phases

### Phase A — a bill can be composed (FR-001..FR-003) · P1

**The defect**: numbers are allocated per work order by `nextRaBillNumber(tx, workOrderId)`; the constraint added on 2026-10-05 reads `@@unique([projectId, billNumber])`. A project's second subcontractor is allocated RA-01 and refused by the database.

**The nullable question, decided here rather than in the migration.** `RABill.workOrderId` is `String?`, and Postgres does not collide NULLs — so `@@unique([workOrderId, billNumber])` leaves every work-order-less bill unconstrained. Three options were considered (research §1); the decision is:

1. The constraint moves to `@@unique([workOrderId, billNumber])`, generated from the schema.
2. **A work order becomes required to create an RA bill**, enforced in the service. `RaBillsService.compose` already types it `workOrderId: string`; only the package path passes `?? null`. Making it required is what gives the constraint its meaning — a rule the database cannot express is held one layer up, deliberately and in one place, rather than left as an unnoticed hole.
3. No partial index, no sentinel. A partial unique index cannot be generated from a Prisma schema, and hand-editing the migration to add one would break Principle VI to paper over a gap that (2) closes properly.

**Also**: `bill-package.service.ts` wraps both creates in the `P2002` → 409 mapping that `ra-bills.service.ts:320` and `client-bills.service.ts:340` already carry. This is why the user saw Prisma's own text.

### Phase B — one store for a deduction (FR-004..FR-008) · P1

**Do not touch the renderer.** `bill-pdf.renderer.ts` and `bill-abstract.ts` already read all ten `BillPackage` adjustment columns and print them correctly. The defect is upstream: a second store exists.

- `RABill.advanceRecovery` / `otherDeductions` stop accepting input; `setAdjustments` is the only route.
- **The data migration is the risky half.** Existing rows carry values that are visible on screen today. They are copied into the package's columns where a package exists; **a bill with no package has nowhere to put them**, so those bills keep their values readable and the fields become read-only rather than removed. Dropping the columns is explicitly _not_ in this phase — a column dropped is a figure that cannot be recovered when somebody asks where it went.
- FR-007/FR-008: the Client bills tab composes through the package path, which already proposes from `DwrPeriodFiguresService` for `to_client`. The manual sheet stays as the correction route and an overridden quantity carries a reason.

### Phase C — two approval subjects, one mechanism (FR-009, FR-010) · P2

`WorkOrderStatus` gains `pending_approval`. `ACTION_WORK_ORDER_AWARD` registers on the same chain machinery as `ACTION_RA_BILL`; a package composed against an award that is not approved is refused by name. Then `ACTION_PURCHASE_RATE_CHANGE` — **the inventory module's first approval of any kind**, which is why it is planned here and not in Phase D: the machinery arrives once, and Phase D consumes it.

### Phase D — the vendor–item agreed rate (FR-011..FR-017) · P2

New table in `inventory`, shaped on `settings.HireRate`: `[companyId, vendorId, itemId, effectiveFrom]`, `effectiveTo` null meaning current. RLS probe required.

- First purchase of a pair accepts a typed rate and records it. A known item from a new vendor **is** a first purchase.
- Later purchases are supplied the agreed rate, **and the service refuses a different one** — `PATCH /purchases/:id` is the path that matters, because a disabled input over an open endpoint is a control in appearance only.
- Forward only; an approved change applies from approval onward.
- FR-016's sibling-vendor rates beside a first entry, and the first-purchase report.
- FR-017: bill and photo required **before approval**, not at creation. `Purchase.billFile` exists and is optional; there is no photo column.

**Worth stating because it reaches further than it looks**: `stock.service.ts` recomputes a weighted average on every receipt, so the purchase rate moves the value of every unit of that item already held. This control is not only about what a vendor is owed.

### Phase E — documents and money that leaves (FR-018..FR-021) · P3

- The debit note's number from `CodeSeriesService`, allocated **when the debit is raised**, so the document and the register cannot disagree.
- A standalone debit-note PDF **reusing `bill-pdf.renderer.ts`'s primitives**, not a second renderer.
- Signed copies through `StorageService` on the DWR attachment pattern, for both an RA bill and a debit note, with acknowledgement as a **state** and not merely a file.
- Bill payments: new table, RLS probe, partial payments allowed. **Outstanding is derived — certified less paid — and never stored**, readable across a subcontractor's bills.

### Phase F — daily work (FR-022..FR-024) · P3

The report workbook against `docs/4280 -DPR -Medshi to Washim 05.10.2026.xlsx`, through the renderer pattern `bill-workbook.renderer.ts` already establishes. Weather out of the create/update DTOs and the form, **column kept**. Author names for both identities, reusing `project-documents.service.ts`'s `actorNames` rather than writing a second one.

### Phase G — the screens (FR-025..FR-030) · P3 · web only

**No API change in this phase at all.** Every value is already in a response the screen receives.

Subcontractor ahead of work order on the package composer, narrowed by `partnerId`, **selection cleared when the subcontractor changes**, and work orders with a null `partnerId` or null `code` given their own entry rather than filtered out of existence. The company-switch 404 handled **once** in the project shell layout. The Commercial terms card. The Issue label.

---

## Test strategy

Seven tests, one per phase, each carrying the vacuity note from `spec.md` **verbatim**. This is planned rather than deferred because an assertion that passes for the wrong reason is this repository's recorded failure mode — nine times, most recently a sort placed in `submit()` instead of `view()` that kept 1,875 tests green while the screen was unchanged.

| Phase | The assertion                                                                                     | What would make it vacuous                                                             |
| ----- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A     | Two work orders on one project each hold a bill numbered RA-01, read off the composition response | Asserting only that composition returned 201 — it did before, for the first work order |
| B     | The figure read out of the **rendered** PDF                                                       | Asserting the column was written                                                       |
| C     | A bill composed against an unapproved award is refused, **and succeeds once approved**            | Only the refusal — a guard that refuses everything passes it                           |
| D     | The rate unchanged after an attempt **through `PATCH /purchases/:id`**                            | Asserting the form field is disabled                                                   |
| E     | Outstanding reported as certified less paid, on a **part** payment                                | Asserting the payment row exists                                                       |
| F     | The workbook's cells, read back                                                                   | Asserting the download returned bytes                                                  |
| G     | The work order selection **after** the subcontractor changes                                      | Asserting the subcontractor control renders                                            |

---

## Risks

1. **Phase B's data migration is the only irreversible step in the feature.** Copying deductions into package columns is a one-way move. Mitigated by not dropping the source columns in this phase.
2. **Phase C changes the default state of a work order.** Every existing `active` work order must stay active; only new ones start pending. A migration that sets existing rows to `pending_approval` would make every live project unbillable overnight.
3. **Phase D on the purchase write path.** The rate lookup must be one query. A per-line lookup on a multi-line purchase is the N+1 this plan names in advance.
4. **Phase A's required work order** could refuse a bill somebody raises today without one. Checked before shipping: the composer requires one for `to_subcontractor`, so the change closes a hole rather than removing a capability.

---

## Out of scope

Restated from the spec so it survives into implementation:

- **"Document is mandatory" on edit — WITHDRAWN, and no code change.** The gate is creation-only; the edit form neither fetches requirements nor sends staged ids; it stopped reproducing. A task that changes code here has misread the feature.
- The project schedule and progress module (026).
- The nine pre-existing index-name drifts — excluded from every generated migration.
- Per-client layouts for the daily report.

---

## Complexity Tracking

| Addition                               | Why it is necessary                                                                   | Simpler alternative rejected because                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Three new tables                       | Each holds a fact nothing currently records: an agreed rate, a payment, a signed copy | Columns on existing rows cannot carry a history (rates change, payments are many per bill)    |
| A second approval action in one phase  | The machinery arrives once for the award; the rate change reuses it                   | Building them in separate features means standing the inventory module's first chain up twice |
| A new enum value rather than a boolean | `pending_approval` sits in a sequence that already exists                             | A boolean beside a status is two sources of truth for one state                               |
