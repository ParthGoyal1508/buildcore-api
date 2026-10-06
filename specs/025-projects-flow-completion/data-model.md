# Data Model: Projects Flow Completion

## There is no data-model change.

This document exists to record that as a finding rather than an omission, and to show the audit
behind it. A feature that adds configuration surfaces and a planning endpoint looks like a feature
that adds columns; this one does not, because every column was added by an earlier feature and left
unreachable.

| Requirement | Column it needs | Where it already is | Added by |
|---|---|---|---|
| FR-009 to FR-015 | `BoqItem.startDate`, `.finishDate`, `.duration`, `.perDayQty` | `projects.BoqItem` | 008 |
| FR-014 | `BoqItem.doneQty` (for the achieved rate) | `projects.BoqItem` | 008, incremented by 022 |
| FR-016 to FR-020 | `Project.clientRetentionFraction` | `projects.Project`, nullable, no default | 023 |
| FR-021 to FR-024 | `Company.cgstFraction`, `.sgstFraction`, `.igstFraction`, `.tdsFraction` | `settings.Company`, beside `bocwCessRate` | 023 |
| FR-024 | an audit entity type for the change | `AuditEntityType.COMPANY` | 002 |
| FR-006 | `DailyWorkReport.createdByUserId`, `.submittedByUserId` | `projects.DailyWorkReport` | 022 |

## What follows from that

**No migration.** The constitution's Development Workflow clause - every schema change ships a
generated migration and never a hand-edited one - has nothing to govern here. The absence of a
`prisma/migrations/` entry in this feature is therefore correct, and a reviewer expecting one should
read this table instead of looking for a missing file.

**No RLS probe suite.** Principle I requires a probe under a `NOSUPERUSER NOBYPASSRLS` role for any
new table, because the development and CI role is a superuser and Postgres exempts superusers from
row-level security unconditionally. No table is new. Every table this feature touches already
carries `tenant_isolation` and is already proven: `BoqItem` and `Project` by 008's probe, `Company`
by 002's, `DailyWorkReport` by 022's, and the four bill-package tables by 023's.

**The one shape that does change is a response, not a row.** `DwrService.list` grows two columns in
its `select` - see research.md section 1 - which changes what the endpoint returns without changing
what is stored. The published contract moves in the same commit.

## Field semantics worth stating once

| Field | Type | Range | Meaning |
|---|---|---|---|
| `BoqItem.startDate` | date, nullable | - | When the line's work began. Null means unplanned. The achieved rate is `doneQty / days elapsed since this date`, so a null here is why *Avg / day* reads *Not planned*. |
| `BoqItem.finishDate` | date, nullable | must not precede `startDate` | When the line must be complete. Null means unplanned, and a null here is what puts a line in the `unplanned` state rather than in one of the four alert states. |
| `BoqItem.duration` | int, nullable | >= 1 | Planned working days. Advisory - the needed rate is derived from `finishDate` when `perDayQty` is absent, not from this. |
| `BoqItem.perDayQty` | decimal(18,3), nullable | >= 0 | An explicit per-day target that **overrides** the derived needed rate. Null means derive. |
| `Project.clientRetentionFraction` | decimal(8,6), nullable | 0 to 1 | The client contract's retention term **as a fraction** - 0.05 is 5%. Null is not zero: it is a refusal to compose, because billing at zero retention makes the payable five per cent too high. |
| `Company.cgstFraction` etc. | decimal(8,6) | 0 to 1 | Statutory rates, frozen onto a package at issue. Changing one moves future bills only. |
