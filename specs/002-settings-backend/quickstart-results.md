# Quickstart validation results — Settings Module Backend

**Run**: 2026-08-29, local environment (Postgres `buildcore` @ localhost:5432, all 7 migrations
applied, nine default roles seeded).
**Method**: `quickstart.md`'s scenarios are executed as the automated e2e suite
(`test/settings.e2e-spec.ts`, 35 tests) plus the two direct database probes recorded under
Scenario 8. Result: **35/35 e2e passing, 65/65 unit passing**.

| Scenario | Steps | Result | Where |
|---|---|---|---|
| 1 — Company creation and scoping | 1–5 | **PASS** | e2e "Companies (US1)" |
| 2 — Roles and permission enforcement | 1–6 | **PASS** | e2e "Roles (US2)" |
| 3 — User administration | 1–5 | **PASS** | e2e "User administration (US3)" |
| 3 — User administration | 6–7 | **NOT RUN** | depends on feature 010 (below) |
| 4 — Reference masters | 1–7 | **PASS** (7 with a stub) | e2e "Departments, Designations and Shifts" |
| 5 — Document type seeding | 1 | **PASS** (17 defaults, not 16) | e2e "Document Types (US5)" |
| 5 — Mandatory-doc attendance gating | 2 | **PARTIAL** | check implemented + unit-tested; no caller exists |
| 6 — Employee code generation | 1–3 | **PASS** (200 concurrent, not 50) | e2e "Employee code series (US7)" |
| 7 — Audit logging | 1–2 | **PASS** | e2e "Audit trail" |
| 8 — RLS review (T082) | — | **PASS, with an environment caveat** | direct DB probe, below |

## Deviations from quickstart.md as written

- **Scenario 5.1 expects "all 16 default types"** — 17 are seeded. The PRD's enumerated table lists
  17 rows; data-model.md's prose collapses the 10th and 12th marksheets into one "Marksheets"
  entry. The PRD table was taken as authoritative.
- **Scenario 6.2 asks for 50 concurrent calls** — the e2e run fires 200 against the real database,
  and `employee-code.service.spec.ts` asserts the full 1,000-call contract from SC-007 against a
  counter standing in for the atomic statement.
- **Scenario 2.6 expects `role: null`** on a user whose role was deleted. The response field is
  `roles: []` — an array, because an account can hold several roles (the 2026-08-28 clarification
  feature 001 shipped as `settings.UserRole`). The observable behavior is what the scenario
  requires: assignments are cleared and the next permission-gated request is rejected.

## Not runnable — blocked on feature 010 (account-creation)

Scenario 3 steps 6 and 7 exercise `pending` accounts, `inviteExpiresAt`, and the invite/
set-password lifecycle. None of that exists: `UserStatus` has only `active` and `deactivated`, and
there is no `AccountCreationModule`. The `pending → active` 400 these steps expect cannot be
implemented until 010 introduces the state it rejects.

Scenario 3 step 7's "all refresh tokens revoked immediately" **is** satisfied, by a different
mechanism than row deletion: feature 001's `jwt.strategy.ts` re-validates account status and
re-loads permissions on every request, and `auth.service.ts` rejects login and refresh for any
non-`active` account. A deactivated account therefore loses API access on its very next request
without this feature revoking anything.

Scenario 4 step 7 and Scenario 5 step 2 both need the Employees module, which does not exist. The
deletion guard's wiring is verified in e2e with the reference-check hook stubbed to `true`; the
hook itself returns `false` until Employees lands and exports a real check.

## Scenario 8 — RLS review (T082)

Coverage on every table, read from `pg_class`/`pg_policies`:

| Table | RLS | Forced | Policies | Intended? |
|---|---|---|---|---|
| `settings.Department` | ✓ | ✓ | 1 | yes |
| `settings.Designation` | ✓ | ✓ | 1 | yes |
| `settings.DocumentType` | ✓ | ✓ | 1 | yes |
| `settings.Shift` | ✓ | ✓ | 1 | yes |
| `settings.EmployeeCodeSequence` | ✓ | ✓ | 1 | yes |
| `settings.Company` | ✗ | ✗ | 0 | **yes** — tenant root, has no `companyId`; gated by the `COMPANY_SETTINGS` permission instead (research.md §8, FR-001) |
| `settings.Role` | ✗ | ✗ | 0 | **yes** — role definitions are global reference data shared across companies, not tenant rows |
| `settings.UserRole`, `shared.*` | ✓ | ✓ | 1 each | feature 001's, unchanged |

Behavior probed directly against the policies, as a non-superuser role:

| Session context | Rows visible |
|---|---|
| own company, `app.is_super_admin=false` | 1 |
| different company, `app.is_super_admin=false` | **0** — isolation holds |
| different company, `app.is_super_admin=true` | 1 — bypass works |

Identical to feature 001's pattern, as SC-003 requires.

### Environment caveat (not a defect in this feature)

The local application connects as the Postgres role `prisma`, which is a **superuser**
(`rolsuper = true`). Postgres superusers bypass row-level security unconditionally — `ENABLE` and
`FORCE ROW LEVEL SECURITY` do not apply to them. The policies above are therefore correct but
**inert in this local environment**, and the same is true of every RLS policy feature 001 wrote.
The probe results in the table above were obtained by running the same queries under a purpose-made
non-superuser role, which is the only way to observe the policies working.

For Principle IV's isolation guarantee to hold in a deployed environment, the application must
connect as a non-superuser role that also lacks `BYPASSRLS`. That is a deployment/provisioning
concern spanning both features, not something either feature's migrations can enforce.
