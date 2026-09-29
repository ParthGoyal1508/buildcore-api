# Research: Access Granularity and Multi-Company

**Date**: 2026-09-29. Every finding below was read out of the code, not inferred from the
specification. Where the two disagree, that is recorded as a finding rather than reconciled quietly.

## §1 — The permission model as it stands

`Permission` is a Prisma enum in the `settings` schema with 34 values. `Role` carries
`permissions Permission[]` — a **scalar list**, not a join table. There is no level, no area/level
separation, and no row per grant.

Consequence for FR-001: a level cannot be attached to an entry in a scalar list. Either the enum
doubles (`*_READ`, `*_WRITE`) or the list becomes a table. Plan D1 takes the table.

## §2 — The specification overstates what is inexpressible

The spec's opening section says the client's Note 22 example "cannot be expressed at all":

> *a site operator who may enter logbook readings and diesel, but may not see the rest of the
> machinery register and may not edit anything else.*

Checked against the code:

| Clause | True today? | Evidence |
|---|---|---|
| may enter logbook readings | Yes | `plant/logbook` guarded by `Permission.LOGBOOK` alone |
| and diesel | Yes | `plant/fuel` guarded by `Permission.FUEL` alone |
| may not see the rest of the machinery register | Yes | machinery routes require `MACHINERY`, which such a role does not hold |
| **may not edit anything else** | **No** | holding `LOGBOOK` grants read and write together; there is no level |

So three of the four clauses are already satisfiable by a role holding `LOGBOOK` and `FUEL`. The area
granularity FR-002 asks for exists; only the level is missing.

This matters to scope: US1 is one model change and one guard change, not a redesign of the permission
vocabulary. It is recorded here because the specification would otherwise send planning toward
inventing sub-module areas that are already there.

## §3 — The guard admits unguarded endpoints unconditionally

`src/common/guards/permissions.guard.ts`:

- Semantics are **OR**: `required.some((p) => user.permissions.includes(p))`.
- An endpoint with **no** `@RequirePermissions(...)` returns `true` — "matches today's
  authenticated-only behavior", per its own comment.

Counted: 419 route decorators across the controllers, 116 `@RequirePermissions` declarations (some at
class level, covering several routes). Eight controllers declare none at all:

| Controller | Routes | Assessment |
|---|---|---|
| `hr/punch` | 4 | Self-service `/my/*` — a permission would be wrong |
| `hr/leave` | 4 | Self-service |
| `hr/reimbursements` | 6 | Self-service |
| `hr/biometrics/face-enrolment` | 5 | Self-service |
| `payroll/salary` | 3 | Self-service (`/my/salary`) |
| `users` | 3 | **Genuinely unguarded** |
| `account-creation/invites` | 2 | **Genuinely unguarded** |
| `app` | 1 | Health check; effectively public |

So the hole is 6 routes, not 28 — the `/my/*` surfaces are correct as they are. The defect is not the
count but the *mechanism*: the guard cannot distinguish a deliberate self-service route from a
forgotten one, so FR-005 cannot hold as a property of the system. Plan D4 makes the deliberate case
explicit and fails closed on the rest.

## §4 — What "cash" is, concretely

FR-014 and FR-015 require hiding cash "across the application", which needs the surfaces named. The
schema holds cash in four places and nowhere else:

| Location | Line | Note |
|---|---|---|
| `enum PaymentMode { upi, bank_transfer, cash, cheque }` on `Payment.paymentMode` | 3665, 3928 | The general case |
| `enum LabourPaymentMode { cash, bank }` on a payment-sheet disbursement | 4760, 5071 | Labour wage disbursement |
| `LabourPaymentSheet.denominationBreakup Json?` | 5027 | Cash by construction — a note-count breakup exists only for cash |
| `CompanySettings.labourCashDenominations Int[]` | 315 | Configuration, not a transaction — **not** hidden |

The fourth is the interesting one: it looks like cash and is not. Hiding a company's configured note
denominations would break the payment-sheet builder while hiding nothing anybody was trying to hide.

`LabourPaymentSheet` is the spec's own unresolved edge case: the sheet exists to be taken to site and
counted out, so hiding its amounts may leave a screen with no purpose. Recorded as an assumption, not
resolved (plan D6).

## §5 — Multi-company is real below the application

- Every company-scoped table has RLS with a `tenant_isolation` policy.
- `Permission.CROSS_COMPANY_ACCESS` exists and its schema comment says it "replaces the old hardcoded
  `role === SUPER_ADMIN` schema exception".
- `src/settings/companies/` and `src/settings/users-admin/` already read it.

So FR-008 to FR-013 add a **selection**, not isolation. The distinction is the whole of plan D5: if
the selection were the isolation, a forged selection would be a cross-tenant read. It is not — RLS
still refuses, and the selection only chooses which company's context a request runs in.

## §6 — Role management already exists

`src/settings/roles/` has a service, a controller and DTOs, with `roles.service.spec.ts` covering it.
FR-007 — "allow an administrator to define these finer roles without a code change" — is therefore
**already satisfied for composition**: an administrator can create a role and choose its permissions.

What FR-007 cannot mean is inventing a new *area*, because areas are enum values and adding one is a
migration. Read precisely, FR-007 asks that roles be composable from the existing vocabulary without
a developer, which is true today and stays true after D1 adds the level to the payload.

Stating this matters because the opposite reading — administrators defining arbitrary new permission
areas — would be a materially larger feature and is not what the note asks for.

## §7 — Roles are not company-scoped, and the spec says they are

`model Role` has `name String @unique` and no `companyId`. The spec's Key Entities describes a role
as "a named set of permissions, company-scoped, definable by an administrator".

Divergence recorded, not resolved: nothing in FR-001 to FR-017 requires per-company roles, and adding
`companyId` would change every `UserRole` and every role lookup in the system. Plan D8.

## §8 — The migration hazard is known and has already bitten

Five migrations failed or silently did nothing in production on 2026-09-16 because their data
statements ran under RLS with neither GUC set, as `buildcore_app` (NOSUPERUSER, NOBYPASSRLS), while
local development runs as SUPERUSER and bypasses RLS entirely.

This feature's migrations include a **backfill over every role in the system** — precisely the shape
that failed, and the worst shape to get wrong, because an `UPDATE` matching zero rows leaves the
deploy green with every role's permissions unset. Every data statement here sets
`app.is_super_admin` transaction-locally, and Phase 1's gate is the before/after access matrix rather
than a green deploy.
