# Research: Settings Module Backend (Companies, Users, Roles & Reference Data)

## 1. Starting point: what already exists vs. what this feature must add

**Decision**: Treat this as the first real module work under the `settings` schema named in the
constitution's Principle I. Nothing settings-related exists yet — `prisma/schema.prisma` has only
the placeholder `User` model (`shared` schema, once feature 001 lands) with a `role Role` enum
field (`ADMIN`/`USER`). This feature adds the entire `settings` schema (Company, Role, Department,
Designation, DocumentType, Shift, EmployeeCodeSequence) plus the cross-schema link from `User` to
the new dynamic `Role` table.

**Rationale**: Same posture as feature 001 (001-user-login-backend/research.md §1): new module work
follows Principles I–VI from the start rather than retrofitting the un-split skeleton.

**Alternatives considered**: Wait for feature 001 to be implemented first, since this feature
modifies the `User` model it introduces — rejected as a hard dependency: both features are still at
the spec stage in this repo (no migrations exist yet for either), so there's no risk of this
feature's schema changes conflicting with already-applied migrations. The two specs' data models
are reconciled here (§2) so whichever is implemented first, the other's plan already accounts for
it.

## 2. Superseding feature 001's `User.role` representation

**Decision**: `shared.User` gets a `roleId` foreign key into `settings.Role.id`, replacing the
placeholder `Role` enum (`ADMIN`/`USER`) entirely. Feature 001's data-model.md noted the full role
list as "a separate concern (Account Creation feature)" — this feature is the one that actually
owns the dynamic Roles master (per this repo's own PRD-derived spec), so it is the authority on how
`User` stores its role, superseding that earlier note. Feature 001's own functional requirements
(FR-005, FR-009, FR-010) only require reading and comparing a role/permission set at request time —
they don't mandate enum storage, so this change doesn't conflict with anything feature 001
functionally needs.

**Rationale**: A single hard-coded enum cannot represent admin-defined custom roles (spec User
Story 2) or a per-role permission set drawn from the fixed permission enumeration (clarification:
fixed enumerated set). A FK to a real table is the only representation that supports create/edit/
delete on roles and an accurate per-role assigned-user count (FR-009).

**Alternatives considered**: Keep `Role` as an enum and add a *separate* `permissions` table keyed
by enum value — rejected: enums can't be created/deleted at runtime (Prisma enum changes require a
migration), which directly contradicts User Story 2's "create custom roles" requirement.

## 3. Cross-schema reference: `shared.User.roleId` → `settings.Role.id`

**Decision**: The foreign key column exists at the database level (Prisma multi-schema supports a
relation whose two sides live in different Postgres schemas within one database), but each
module's own Prisma queries still only read/write their own schema's tables, per Principle I. The
Auth module (`shared`) needs a role's name and permission set at login time to embed in the JWT; it
gets this by calling `SettingsModule`'s exported `RolesService.getRoleById(roleId)` (an in-process
NestJS provider call), never by a Prisma `include`/join that reaches into `settings.Role` from
`shared`'s own query. Symmetrically, `SettingsModule`'s user-administration endpoints (User Story 3)
need basic account fields (name, email, status, lastLoginAt) — obtained via `AuthModule`'s exported
`UsersService` methods, not a direct Prisma query against `shared.User` from `settings`.

**Rationale**: This is exactly Principle I's "anything one module needs from another MUST go
through that module's exported service method" — the FK is a data-integrity constraint at the
Postgres level (Prisma multi-schema explicitly supports cross-schema relations for this reason),
not a license for either module's application code to query across the boundary directly.

**Alternatives considered**: Denormalize a copy of role name/permissions onto `User` at
assignment time instead of a live FK — rejected: FR-012 requires a role's current permissions to
take effect on the affected user's very next authenticated request, which a denormalized copy would
make stale the moment an admin edits that role elsewhere.

## 4. Permission representation: fixed enumerated set

**Decision**: A `Permission` Postgres enum (module/action identifiers such as `DASHBOARD`,
`EMPLOYEES`, `ATTENDANCE`, `PROJECTS`, `MACHINERY`, `INVENTORY`, `PARTNERS`, `REPORTS`, `PAYROLL`,
`CHALLANS`, `LOANS`, `LOGBOOK`, `FUEL`, `DAILY_WORKER_REGISTRY`, `MY_WORKSPACE`, `SETTINGS`,
`USER_MANAGEMENT`, `COMPANY_SETTINGS`, `DATA_EXPORT`, `DATA_DELETE`) covering every permission named
across the PRD's default-role table. `Role.permissions` is stored as a native Postgres array of this
enum (`Permission[]` in Prisma) rather than a join table, since a role's permission set has no
independent per-row lifecycle (no timestamps, no per-permission metadata) — it's an unordered set
attribute of the role itself.

**Rationale**: Matches the clarification (fixed enumerated set, not freeform text) and lets
server-side RBAC checks (`RolesGuard`/`@RequirePermission()`, extending feature 001's
`@Roles()`/`RolesGuard` pattern) validate against `Permission` values the type system already knows
about, rather than pattern-matching arbitrary strings.

**Alternatives considered**: A `RolePermission` join table (`roleId`, `permission` enum) — rejected
as unnecessary complexity for the same reason feature 001 rejected a separate `LoginAttempt` table
(research.md §4): no independent lifecycle to justify the extra table and joins on the hottest
authorization-check path.

## 5. Super Admin protection

**Decision**: Two independent guards, both enforced in `RolesService`/`UsersService`, not only at
the DTO layer:
- **Role-level**: `Role.isProtected` boolean, `true` only for the seeded Super Admin row. Any
  update/delete request targeting a protected role is rejected before touching the database,
  regardless of caller (FR-008).
- **Account-level**: before deactivating, deleting, or reassigning a user away from the Super Admin
  role, `UsersService` counts currently-active accounts holding that role; if the target account is
  the last one, the operation is rejected (FR-016).

**Rationale**: These are two distinct failure modes named in the spec (Edge Cases, FR-008, FR-016) —
protecting the role definition doesn't by itself stop the last Super Admin *account* from being
deactivated, and vice versa, so both checks are required.

**Alternatives considered**: Enforce only at the UI layer with a warning dialog — rejected outright
by the constitution's Principle IV/V posture (server-side enforcement, not UI-only) and by this
feature's own NFR ("Access control enforcement... at the API/middleware layer").

## 6. Employee code sequence generation (concurrency-safe)

**Decision**: A dedicated `EmployeeCodeSequence` row per company (`companyId`, `lastNumber`), and an
exported `SettingsModule` service method `getNextEmployeeCode(companyId)` that performs an atomic
`UPDATE settings."EmployeeCodeSequence" SET "lastNumber" = "lastNumber" + 1 WHERE "companyId" = $1
RETURNING "lastNumber"` inside a single statement (Postgres guarantees this is race-free without
explicit row locking, since the increment and read happen in one atomic operation) and formats the
result as `{shortCode}-{lastNumber zero-padded to 4 digits}`. The future Employees module calls this
method when creating an employee record; it never reads or writes `EmployeeCodeSequence` directly.

**Rationale**: `UPDATE ... RETURNING` is the standard Postgres-safe counter pattern — it avoids the
read-then-write race a naive "read lastNumber, add 1, write it back" approach would have under
concurrent employee creation (spec User Story 7, SC-007's 1,000-concurrent-request target).

**Alternatives considered**: A native Postgres `SEQUENCE` per company, created dynamically —
rejected: Prisma has no first-class support for per-row dynamic sequence creation/management, and a
single counter row per company is simpler to seed, inspect, and reset than N database sequence
objects.

## 7. Document Type derived flag

**Decision**: Store the three independent booleans (`isMandatory`, `hasExpiry`, `needsNumber`) as
the source of truth; compute the derived display flag (`MandatoryNumber`/`Mandatory`/
`ExpiryNumber`/`Expiry`/`Number`/`Optional`) in the service layer on read, not as a stored column.

**Rationale**: The mapping (spec User Story 5, Acceptance Scenario 1) is a pure deterministic
function of the three booleans — storing it redundantly risks drift if a toggle is edited without
recomputing the flag; computing on read has no meaningful cost at this data volume (a handful of
document types per company).

**Alternatives considered**: A stored generated column (Postgres `GENERATED ALWAYS AS`) — rejected
as unnecessary: Prisma's migration tooling doesn't manage generated columns as cleanly as plain
columns, and the computation is trivial enough to belong in application code alongside the DTO that
serializes it.

## 8. Company-scoped uniqueness and RLS extension

**Decision**: Extend the RLS pattern feature 001 establishes (research.md §5: session-level
`app.current_company_id`, with an explicit `app.is_super_admin` bypass) to every new `settings`
schema table that carries `companyId` (Department, Designation, DocumentType, Shift,
EmployeeCodeSequence). `Company` itself is the tenant root and is *not* RLS-filtered by
`companyId` (it doesn't have one — it *is* the company); instead, only Super Admin may create/edit/
deactivate a company (FR-001), enforced via the existing `RolesGuard`/permission check
(`COMPANY_SETTINGS` permission), not RLS. Department/Designation/Shift each get a composite unique
constraint on `(companyId, name)`; DocumentType gets one on `(companyId, code)`.

**Rationale**: Reuses an already-decided pattern instead of inventing a second multi-tenancy
mechanism; the composite uniqueness constraints directly express the per-company scoping the
clarification settled on (User Story 4/5/6 acceptance scenarios: same name/code allowed in
different companies, not within one).

**Alternatives considered**: Application-layer-only uniqueness checks (query-then-insert) without a
database constraint — rejected: a race between two concurrent creates could pass both checks before
either insert lands, matching exactly the class of bug Principle IV's RLS rationale calls out
("even if application code has a bug").

## 9. Audit log integration

**Decision**: Extend feature 001's `AuditLogEntry` model (`shared` schema) from a fixed
`eventType` enum scoped to login events into a more general shape: `entityType` (e.g. `COMPANY`,
`ROLE`, `DEPARTMENT`, `DESIGNATION`, `DOCUMENT_TYPE`, `SHIFT`, plus the existing login-related
values), `action` (`CREATE`/`UPDATE`/`DELETE`, plus existing login-specific actions), `entityId`,
and an optional `changes` JSON snapshot — superseding the single flat `eventType` enum. This feature
writes to it via the same shared `AuditLogService.record()` in-process call feature 001 establishes
(never a direct Prisma write from `settings` into `shared`'s table), consistent with §3 above.

**Rationale**: FR-025 requires every Companies/Roles/reference-data change to be audited; growing
feature 001's `eventType` enum with a dozen more settings-specific values (`company_created`,
`role_updated`, `department_deleted`, ...) would work but doesn't generalize to the next module that
needs auditing (HR, Payroll, ...). Generalizing now, while only two features exist, is cheaper than
a later migration once more event types have accumulated. As with §1/§2, both features are still
unimplemented specs, so this is a specification-level reconciliation, not a breaking migration.

**Alternatives considered**: Leave feature 001's enum as-is and add a second, settings-specific
audit table — rejected: splits one conceptual audit trail across two tables/query surfaces for no
benefit, and this repo's NFRs (both features) describe a single "Activity Log," not one per module.

## 10. GSTIN / PAN format validation

**Decision**: Validate with `class-validator` `@Matches()` against the standard statutory formats:
GSTIN `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$` (15 characters), PAN
`^[A-Z]{5}[0-9]{4}[A-Z]{1}$` (10 characters), applied in the Company create/edit DTO.

**Rationale**: These are the published statutory formats (GSTIN per GST Council spec, PAN per
Income Tax Department spec) — validating format at the DTO boundary (Principle II) catches obvious
data-entry errors before they reach Challan generation or other modules that depend on these codes
being well-formed (per the PRD's stated downstream usage).

**Alternatives considered**: No format validation, free text — rejected: the PRD explicitly lists
these as driving Challan generation elsewhere in the system; a malformed code silently breaks that
downstream feature instead of failing fast at entry.

## 11. Configuration centralization

**Decision**: Company-level payroll defaults (PF 12%, ESIC 3.25%, Gratuity 4.81%, Bonus 8.33%) are
seed-time defaults read from a typed `SettingsConfig` addition to `config.interface.ts`/`config.ts`
(Principle III), not hard-coded inline in the service that creates a new company — they remain
per-company editable data afterward (FR-002), the config only supplies the initial value at
creation time.

**Rationale**: Keeps the "default at creation, editable per company thereafter" behavior (FR-002)
consistent with Principle III's centralized-configuration rule while still satisfying the spec's
requirement that these rates be admin-editable without a code release once a company exists.

**Alternatives considered**: Hard-code the defaults directly in `CompaniesService.create()` —
rejected: a magic-number literal is exactly what Principle III prohibits for a value that's
reasonably expected to change (statutory rate updates).
