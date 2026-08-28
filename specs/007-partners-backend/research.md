# Research: Partners Backend (Vendors, Contractor Vault, Compliance, RAG Matrix, BOCW Cess)

## 1. Schema placement

**Decision**: A single new `partners` schema owns all entities: `VendorCategory`, `Vendor`,
`VendorContact`, `VendorDealsIn`, `VendorHireDetail`, `ContractorProfile`, `ContractorDocument`,
`MonthlyCompliance`, `BOCWPayment`. One additive field (`bocwCessRate`) is added to
`settings.Company` via this feature's migration — owned here, read via `SettingsService`, exactly
as 005 did with `otMultiplier`.

**Rationale**: `partners` is a named schema in the constitution's canonical module list. All
entities are squarely vendor/contractor concerns. Putting them together gives `PartnersModule` a
clean future-extraction boundary.

## 2. Contractor as 1:1 Vendor extension (`ContractorProfile`)

**Decision**: A `Contractor` is not a separate master entity — it is a `ContractorProfile` table
that extends a `Vendor` record 1:1 (unique FK: `ContractorProfile.vendorId`). A `ContractorProfile`
can only be created for a `Vendor` with `type IN ('subcontractor', 'labour_contractor')`.
`ContractorProfile` carries all compliance-specific fields (registration numbers, `complianceStatus`).
Deleting a `Vendor` cascades to delete its `ContractorProfile` (and `ContractorDocument` rows) —
vendor is the owner, profile is the extension.

**Rationale**: Avoids duplicating name/address/contact/GST across two master tables. The PRD's
Contractor Vault is a specialized view of the Vendor master, not a separate entity with its own
address and contact records.

**Alternatives considered**: Separate `Contractor` entity independent of `Vendor` — rejected:
every subcontractor is also a vendor (they are paid, their TDS is tracked, they appear in work
orders). A separate entity would require maintaining duplicate contact/GST data.

## 3. `complianceStatus` stored and recomputed on every compliance change

**Decision**: `ContractorProfile.complianceStatus` is a persisted column, not a lazy computation.
Whenever a `MonthlyCompliance` record is created, updated (PF/ESIC fields), or verified, a
`ComplianceStatusService.recompute(contractorProfileId)` call runs inside the same Prisma
transaction. It queries the **most recently concluded calendar month's** compliance record for
that contractor and applies the master PRD §7.7.2 rule:
- Both PF and ESIC submitted or verified → `compliant`
- Exactly one of PF or ESIC submitted → `partially_compliant`
- Neither submitted or no record for the last month → `non_compliant`

The previous 3-month rolling window design has been replaced by this simpler per-month rule
(updated to match master PRD §7.7.2).

**Rationale**: The Contractor list endpoint reads `complianceStatus` directly from the stored
column rather than aggregating `MonthlyCompliance` on every list request. With potentially
hundreds of contractors, an on-demand aggregation on every list read is significantly more
expensive than a one-time recompute triggered by the (infrequent) compliance record change.

**Alternatives considered**: On-demand computation on every contractor list read — rejected:
O(contractors × 3) database reads on every list call is unacceptable at scale; the stored
column is a simple derived cache that is always consistent because it is updated in the same
transaction as the compliance record change.

## 4. RAG Matrix: on-demand computation, inactive contractors excluded

**Decision**: `GET /partners/rag?fy=YYYY-YY` builds the matrix in a single efficient query:
`SELECT contractorProfileId, month, status FROM MonthlyCompliance WHERE month IN [Apr...Mar for FY]
AND contractor.vendor.active = true`. Rows are all active contractors; columns are 12 months.
Cells missing from the query result are `gray` if the month is in the future (compared to
`new Date()`), or `missing` if the month is past. No materialized storage — computed on demand.
Inactive-vendor contractors are excluded from rows (clarification Q3).

**Rationale**: The RAG Matrix is a read-heavy, write-rare view. Building it from a single
batched query (all compliance records for all active contractors for the FY) is far more efficient
than N per-contractor queries. The matrix result is small (50 contractors × 12 months = 600 cells).

## 5. BOCW cess liability: on-demand from ProjectsService

**Decision**: `GET /partners/bocw` calls `ProjectsService.getProjectsWithContractValues(companyId)`
(an exported method returning `{ projectId, name, contractValue }[]`), then joins with
`BOCWPayment` aggregates from the `partners` schema to compute `totalPaid` and `balance` per
project. `cessLiability = contractValue × cessRate` where `cessRate` comes from
`SettingsService.getBocwCessRate(companyId)`. Neither `cessLiability` nor `balance` is stored —
both are computed per request. If `ProjectsService` is unavailable, the endpoint returns
`{ unavailableModules: ['projects'] }` with null liability fields per project — same fallback
pattern as 008.

**Rationale**: Storing cess liability would require re-updating it whenever a project's contract
value changes (in the `projects` module). On-demand derivation is simpler and always consistent.

## 6. `getSubcontractorCostByProject` stub pattern

**Decision**: `PartnersModule` exports `PartnersService` with a `getSubcontractorCostByProject(
projectId, dateRange): Promise<number>` method. The implementation calls `ProjectsService.
getWorkOrderTotalByProject(projectId, dateRange)` — itself a stub in 008 (clarification Q1).
Until 008 implements the real method, this returns 0. Both stubs are tagged with `TODO(008)`.

**Rationale**: Clarification Q1 established the stub pattern. This keeps both features
independently shippable. The interface contract is defined here so 008 knows exactly what
signature to implement.

## 7. `bocwCessRate` migration — 007 owns it

**Decision**: This feature adds `bocwCessRate Decimal @default(0.01)` to `settings.Company`
in `prisma/schema.prisma`, in its own additive migration. `SettingsModule` exports a
`getBocwCessRate(companyId): Promise<number>` service method for `PartnersModule` to call.
Pattern is identical to how 005 added `otMultiplier` to `settings.Company`.

**Rationale**: Clarification Q4. Follows the established pattern: the feature that needs the
rate owns the migration, reads the value via `SettingsService`.

## 8. Month-end compliance cron — last month only, `@nestjs/schedule`

**Decision**: A `@Cron('0 8 1-5 * *')` job (8am, days 1–5 of each month) checks for every
active contractor whether a `MonthlyCompliance` record exists for the most recently concluded
calendar month. Missing contractors emit a `compliance.missing` event via `@nestjs/event-emitter`
(not a direct notification write). `@nestjs/schedule` is a pre-approved NestJS package and is
added here as its first consumer.

**Rationale**: Clarification Q5 established last-month-only scope. `@nestjs/event-emitter` is
the constitution's mandated pattern for cross-module side effects (Principle I). Running on days
1–5 satisfies the PRD's "within 5 days of month-end" target.

## 9. Permission enum — three new values

**Decision**: `VENDORS`, `CONTRACTORS`, `BOCW` are added to Settings' existing `Permission` enum.
`VENDORS` gates all vendor and category endpoints. `CONTRACTORS` gates contractor vault,
compliance, and RAG Matrix. `BOCW` gates BOCW cess endpoints. This brings the total enum size
to 14 values (001–007 contributions).

## 10. VendorContacts — atomic replace on update

**Decision**: `PATCH /partners/vendors/:id` with a `contacts` array in the payload atomically
deletes all existing `VendorContact` rows for that vendor and re-inserts the provided array in
a single Prisma transaction. No partial contact patch (add/remove individual contacts) — the
full contacts array is always replaced. Same pattern for `VendorDealsIn` (category tags).

**Rationale**: Simpler semantics for the client (no separate "add contact" / "remove contact"
endpoints); consistent with the PRD's Contacts tab showing a full list that the user manages
as a whole. The atomicity prevents partial states.

## 11. ComplianceStatus look-back: most recently concluded calendar month

**Decision**: The derivation is based on the **single most recently concluded calendar month**
before today, not a 3-month window (updated to match master PRD §7.7.2). Example: if today is
2026-08-15, the look-back month is July 2026. If a `MonthlyCompliance` record exists for July
with both PF and ESIC fields: `compliant`; only one: `partially_compliant`; none or no record:
`non_compliant`. The current partial month is never included.

**Rationale**: Simpler rule, directly matches the master PRD. The RAG Matrix provides the
full historical view for trend analysis without needing the contractor status to encode history.
