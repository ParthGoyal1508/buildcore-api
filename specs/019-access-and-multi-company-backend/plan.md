# Implementation Plan: Access Granularity and Multi-Company

**Branch**: `019-access-and-multi-company` | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification, client notes 17, 22 and 24 (bugs.md items 19, 16 and 5).

## Scope of this plan

All three user stories. This feature had no plan, no research, no data model, no contracts and no
tasks before today — it is the only api feature in that state, and it carries three of the client's
items, so it is planned whole rather than in slices.

Two things are explicitly **not** in scope, and are recorded rather than quietly absorbed:

- **Making roles company-scoped.** `Role.name` is globally `@unique` and `Role` carries no
  `companyId`. The spec's Key Entities says a role is "company-scoped", which is not true today. See
  D8 — this plan does not change it, because doing so touches every role assignment in the system
  and is not needed by any of the seventeen requirements.
- **The web company switcher.** That is buildcore-web's `019-access-and-multi-company`, still
  unplanned. This plan defines the contract it consumes.

## Summary

The specification's opening claim is that the client's Note 22 example "cannot be expressed at all".
**Half of that is wrong, and the correction is the reason this plan is much smaller than the
specification implies.** `LOGBOOK` and `FUEL` are already `Permission` values distinct from
`MACHINERY`, and `plant/logbook` and `plant/fuel` are each guarded by their own value alone. A role
holding only `LOGBOOK` and `FUEL` today can enter readings and diesel and cannot see the machinery
register. The *area* granularity FR-002 asks for already exists.

What genuinely does not exist is the **level**: holding `LOGBOOK` grants reading and writing
together, with nothing in the model able to say "may read, may not write". That is FR-001 and FR-003,
and it is the whole of the permission work here.

The approach turns on one decision (D2): the required *area* stays where it already is, in the
116 existing `@RequirePermissions(...)` declarations, and the required *level* is derived from the
HTTP method. A GET needs read; a POST, PATCH, PUT or DELETE needs write. No existing declaration is
edited, and FR-003 lands on all 419 routes at once rather than on the handful somebody remembers to
annotate.

## Technical Context

**Language/Version**: TypeScript 5, NestJS 10, Node 20
**Storage**: PostgreSQL (Neon) via Prisma 5.22, multiSchema
**Testing**: Jest — 947 tests / 91 suites green at the time of planning
**Target**: Render web service, `buildcore_app` role (NOSUPERUSER, NOBYPASSRLS)

**Surveyed before planning** (numbers are from the code, not from the specification):

| Fact | Value | Where |
|---|---|---|
| `Permission` values | 34, a Prisma enum in `settings` | `prisma/schema.prisma` |
| Role → permission shape | `Role.permissions Permission[]`, a scalar list. **No join table** | `model Role` |
| Route decorators | 419 | `src/**/*.controller.ts` |
| `@RequirePermissions` declarations | 116 | same |
| Guard semantics | `required.some(...)` — **OR**, and an endpoint with no decorator is **admitted unconditionally** | `src/common/guards/permissions.guard.ts` |
| Controllers with no permission declaration | 8, carrying 28 routes | see D4 |
| — of which `/my/*` self-service | 6 controllers, 22 routes | punch, leave, face-enrol, reimbursements, salary |
| — genuinely unguarded | `users` (3 routes), `account-creation/invites` (2), `app` health (1) | D4 |
| Cash-bearing surfaces | `Payment.paymentMode=cash`; `PaymentSheetDisbursement.paymentMode`; `LabourPaymentSheet.denominationBreakup`; `CompanySettings.labourCashDenominations` | D6 |
| Role management | already exists | `src/settings/roles/` |
| Company isolation | RLS per table, `CROSS_COMPANY_ACCESS` permission exists | `src/settings/companies/` |

**Unknowns**: none blocking. Three open client questions are carried as recorded assumptions and
phased last (see Phase 6 and Risks).

## Constitution Check

| Principle | Assessment |
|---|---|
| **I. Schema-per-module boundaries** (NON-NEGOTIABLE) | `RolePermission`, `AccessLevel` and `PermissionRefusal` all go in `settings`, beside `Role`. `UserCompanySelection` goes in `settings` beside `User`. Nothing new reaches across a schema; the cash interceptor shapes responses and touches no other module's tables. |
| **II. Validated DTO contracts** (NON-NEGOTIABLE) | Role create/update DTOs gain a validated `permissions: {area, level}[]` shape. The company-selection request is a validated DTO carrying a company id, not a bare string. The cash setting is a validated boolean. |
| **III. Centralized configuration** (NON-NEGOTIABLE) | No literal permission lists in services. The verb→level map (D2) is one exported constant. The cash-bearing surface list (D6) is one exported constant, not a condition repeated per module. |
| **IV. Multi-tenant isolation & PII** (NON-NEGOTIABLE) | `PermissionRefusal` and `UserCompanySelection` get `ENABLE` + `FORCE` RLS with a `tenant_isolation` policy in hand-authored SQL, proved with the `NOSUPERUSER NOBYPASSRLS` probe role. **Every data statement in every migration here sets `app.is_super_admin` transaction-locally** — the defect that took production down on 2026-09-16 was exactly this, in exactly this kind of migration. |
| **V. AuthN/AuthZ & secrets** | This feature *is* principle V. The level check is one guard, not a condition copied per controller. `@SelfService()` (D4) makes "no permission required" an explicit, greppable declaration instead of an absence. |
| **VI. Observability & safe migrations** | The backfill is the risk and is treated as one: D1 keeps the old `Role.permissions` column through the cutover so a rollback is a code revert, and drops it in a separate later migration. FR-006 is proved by an access matrix captured before and compared after (SC-002). |

**Gate result**: PASS. Nothing requires justification in Complexity Tracking.

## Approach

### Phase order

The order is driven by one rule: **nothing changes anybody's access until the model can prove it
hasn't.**

1. **The level model, inert.** `AccessLevel`, `RolePermission`, the backfill giving every existing
   entry both read and write. Nothing reads the new table yet. Access is provably unchanged because
   nothing consults it.
2. **The guard reads levels.** Verb-derived level (D2), refusal recording (FR-003). This is the phase
   that can break the application, and it is placed where the model behind it is already proven.
3. **Close the unguarded hole.** `@SelfService()`, real permissions on `users` and `invites`
   (FR-005).
4. **Company selection** (FR-008 to FR-013). Independent of 1–3; sequenced after because a
   half-migrated permission model is a bad place to be adding a request-scoped company context.
5. **Cash visibility** (FR-014 to FR-017). Independent of everything above.
6. **Cash entry restriction** — rests on an assumption, so it is last and separable.
7. **Verification.** The access matrix, NFR-002, the RLS probe.

### What deliberately does not change

- **The 116 `@RequirePermissions(...)` declarations.** D2 exists so that they don't have to.
- **The `Permission` enum's 34 values.** No value is added, renamed or removed. Areas are already
  granular enough for Note 22; see the Summary.
- **`required.some(...)` OR semantics.** A caller holding any one of the named areas at the required
  level passes, as today.
- **Role management's existing endpoints.** They gain a level in their payload; they are not rebuilt.
- **RLS.** Company isolation stays at the data layer. The selection chooses a context; it never
  becomes the only thing between two companies (spec Assumptions).

## Key decisions

### D1 — read/write becomes a row, not a doubled enum

`Role.permissions Permission[]` becomes `RolePermission { roleId, permission, level }` with
`enum AccessLevel { read, write }`.

The alternative was doubling the enum — `MACHINERY_READ`, `MACHINERY_WRITE` — which was rejected for
three reasons: 34 values become 68 and every one of the 116 declarations would have to name which it
meant; a role's grants stop being queryable by area; and the migration would be a rename of live
values rather than an additive table.

The backfill gives **every existing entry both rows**. That is FR-006 read literally: today holding
`MACHINERY` means reading and writing it, so both rows are exactly today's access, and no role gets
tighter until somebody deliberately tightens it. The old column stays until a separate later
migration drops it, so the cutover is revertible by code alone.

### D2 — the level comes from the HTTP method, not from a second decorator

`GET` and `HEAD` require read. `POST`, `PATCH`, `PUT` and `DELETE` require write.

This is the decision the whole plan rests on. The alternative — annotating each route with its level
— means editing 419 routes, and the failure mode is silent: a route somebody forgets keeps admitting
writes from read-only roles, which is FR-003 not holding on exactly the endpoint nobody checked.
Deriving it inverts that. A route is covered because it exists, not because it was remembered.

Where the mapping is wrong, `@RequireLevel(AccessLevel.read)` overrides it explicitly. The known case
is a search or report endpoint that takes a `POST` because its filter does not fit in a query string;
those are read operations wearing a write verb, and Phase 2 enumerates them rather than discovering
them in production.

### D3 — a refusal is recorded, and it records the level that was missing

FR-003 requires the refusal be recorded. `PermissionRefusal` holds the caller, the route, the area
required, the level required, and the level actually held. The last field is the one that makes the
log useful: "refused `MACHINERY`" does not distinguish a role that holds nothing from a role that
holds read and attempted a write, and those are a security event and a UI bug respectively.

### D4 — "no permission declared" stops meaning "open to everyone"

Today an endpoint with no `@RequirePermissions` is admitted unconditionally. That is defensible for
the `/my/*` surfaces — 22 of the 28 such routes — where authorisation is "this is your own record"
and a permission would be wrong. It is not defensible as an *absence*, because the guard cannot tell
a deliberate self-service route from an oversight.

So: `@SelfService()` marks the deliberate ones, and the guard refuses a route that declares neither.
`users` (3 routes) and `account-creation/invites` (2) get real permissions; `app`'s health check gets
`@Public()` as it already effectively is. The guard change is what turns FR-005 from a promise into a
property — after it, a new controller with no declaration fails closed instead of open.

### D5 — company selection is stored server-side, not carried in the token

FR-011 requires the selection to survive a browser restart. Access tokens here are short-lived, so a
JWT claim would not survive one, and a cookie would make the selection a client assertion about
authorisation scope — which is the one thing it must not be.

`UserCompanySelection` is one row per user. It is **validated against the user's accessible companies
on every read**, not only on write: the spec's own edge case is cross-company access being revoked
while the other company is selected, and a stored selection that is trusted at read time is how that
becomes a cross-tenant read. An invalid selection falls back to the user's own company and is
re-recorded.

### D6 — cash hiding shapes the response; it never touches a query or a row

FR-017 is explicit that hiding is display, not data. So this is an interceptor over the response, and
the cash-bearing surfaces are a named closed list, from the survey:

| Surface | What hides |
|---|---|
| `Payment` where `paymentMode = cash` | the amount |
| `PaymentSheetDisbursement.paymentMode = cash` | the amount |
| `LabourPaymentSheet.denominationBreakup` | the whole breakup — it is cash by construction |
| `CompanySettings.labourCashDenominations` | nothing; it is configuration, not a transaction |

A closed list is a liability — a module added later holds cash and nobody updates it — so Phase 5
adds a test that fails when a new `cash`-valued payment mode appears in the schema without being
named here. The list being wrong is then a failing test rather than a figure on a screen somebody was
told would be hidden.

The spec's own edge case stands unresolved by design: a labour payment sheet with its amounts hidden
may be unusable. That is the second open client question, and the assumption recorded is that the
sheet hides its amounts like everything else. It is cheap to overturn.

### D7 — with hiding on, cash may still be entered

The first open client question. The note says hide "all cash transaction and entry", which reads
either way. Display-only is assumed (spec FR-014), and the *reason* it is assumed rather than the
safer-sounding alternative is that preventing entry stops site cash disbursement working — a
visibility toggle that silently halts wage payment is a worse failure than a visible amount.

Phase 6 is where the other reading would be built, and it is last precisely so the client's answer
costs one phase rather than a rewrite.

### D8 — roles stay globally named, and the spec is wrong about this

`Role.name` is `@unique` with no `companyId`; the spec's Key Entities calls a role company-scoped.
Nothing in FR-001 to FR-017 needs per-company roles, and adding `companyId` would touch every
`UserRole` row and every role lookup. Recorded here as a known divergence between spec and schema
rather than silently implemented or silently ignored.

## Complexity Tracking

No constitutional violation requires justification. The one place this plan adds real complexity is
D2's verb→level derivation, which trades an explicit per-route declaration for an implicit rule. That
is a deliberate trade and the override exists for where it is wrong; the alternative was 419 edits
with a silent failure mode.

## Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| The backfill widens or narrows somebody's access | A role silently gains or loses rights, found by a user, not a test | Phase 1 captures an access matrix for every role × every area × every level **before** the migration; Phase 7 compares it after. SC-002 is this. |
| Phase 2 breaks a route whose verb does not match its level | A legitimate read refused as a write | Phase 2 enumerates POST-shaped reads before the guard changes, rather than after |
| A data statement in a migration hits RLS | Deploy goes green with the data unset, or fails with 42501 | Every migration here sets `app.is_super_admin` transaction-locally. This is the 2026-09-16 production failure; it is not hypothetical |
| The cash surface list goes stale | A figure shows that was promised hidden | Schema-parsing test in Phase 5 (D6) |
| Company selection trusted at read time | Cross-tenant read after access revocation | D5 validates on every read, not only on write |
| `PermissionRefusal` grows without bound | A log table nobody prunes | Retention is decided in Phase 3 with a recorded default, not left open |

## Verification

- `npx tsc --noEmit`, `npx eslint <touched files only>`, `npm test`, `npm run test:e2e`
- The access matrix before/after comparison (SC-002) — the gate on Phase 1
- The `NOSUPERUSER NOBYPASSRLS` probe against both new tables (Principle IV)
- NFR-002: the permission decision measured at p95, against the current module-level check as a
  baseline captured in Phase 1. The specification is honest that no baseline exists; Phase 1 creates
  one so the 50ms target means something.

## Phase status

| Phase | Requirements | Status |
|---|---|---|
| 1 The level model, inert | FR-001, FR-006 | Not started |
| 2 The guard reads levels | FR-001, FR-003, FR-004 (contract half) | Not started |
| 3 Close the unguarded hole | FR-005, FR-007 | Not started |
| 4 Company selection | FR-008 to FR-013 | Not started |
| 5 Cash visibility | FR-014 to FR-017 | Not started |
| 6 Cash entry restriction ⚠️ rests on an assumption | FR-014 (other reading) | Not started |
| 7 Verification | SC-002, SC-006, NFR-002 | Not started |
