# Feature 007 Partners — Ratified Implementation Decisions

**Date**: 2026-09-03
**Applies to**: `buildcore-api/specs/007-partners-backend` and `buildcore-web/specs/007-partners`
**Status**: Agreed with the user before implementation began. Binding on this build.

These are the four questions the specs did not settle, asked and answered before any code was
written. Recorded here so the reasoning survives the session, and so a later reader can tell a
deliberate choice from an oversight.

---

## D1 — Build all seven backend user stories

**Decision**: All 7 stories, all 49 tasks, all 10 phases.

**The question**: US6 (BOCW Cess) and US7 (Subcontractor Cost for Projects P&L) both read contract
values from feature 008 Projects, which is not built. Three options were on the table: build
everything with documented stubs; build only US1–US3 (the part that actually unblocks 006, 009,
012 and 013); or build US1–US5 and defer the two 008-dependent stories.

**Why all seven**: `tasks.md` T044 already plans for the gap explicitly — `TODO(008): implement
getProjectsWithContractValues()` in `BOCWService` and `TODO(008): implement
getWorkOrderTotalByProject()` in `PartnersService`. Nothing is being invented to paper over a
missing dependency; the spec anticipated it. Stopping at US3 or US5 would leave 9–23 tasks needing
a re-entry into a feature whose context had gone cold.

**Consequence to accept**: US6 and US7 ship returning empty/zero until 008 lands. That must be
visible in the code as a named TODO, not as a function that silently looks finished.

## D2 — Install the scheduler and event bus, and build the compliance cron

**Decision**: Add `@nestjs/schedule` and `@nestjs/event-emitter`, then build `ComplianceCheckCron`
(T040) as specified — `@Cron('0 8 1-5 * *')`, emitting `compliance.missing` per contractor with no
`MonthlyCompliance` row for the last completed month.

**The question**: neither package is installed, and the events the cron emits have **no consumer** —
feature 004's reminders engine is the intended subscriber and is not built.

**Why build it anyway**: deferring leaves FR-010 unimplemented, which is a silent hole in a
compliance feature. Emitting into a bus nobody listens to is inert, not wrong, and it is the
interface 004 will subscribe to.

**Consequence to accept**: a scheduler now starts in the production process on Render. If the API
is ever run as more than one instance, this job fires once per instance — worth revisiting before
that happens, and not a problem today.

## D3 — Backend then frontend, one continuous run

**Decision**: Build the backend, verify it myself, then build the frontend, with **no
interruptions and no intermediate questions to the user**. Report once, at the end.

**Note**: this order is not a preference. Every frontend spec in this project states that its
backend counterpart must exist first.

## D4 — Verify every frontend schema against live API responses

**Decision**: Run the API locally, call every new endpoint, and validate each frontend zod schema
against the payload the backend actually returns — before declaring the frontend done.

**Why**: feature 005 shipped six bugs of exactly one kind. Frontend zod schemas were written from
the Prisma models and the spec rather than from real responses, so they rejected valid `200`s and
surfaced as "Could not load this list" on screen. Field names were wrong in four schemas
(`punchId` vs `id`, `actorUserId` vs `changedByUserId`, `dayCount` vs `days`, `month` vs `period`),
and each cost a round of screenshots to find. The zod boundary caught them all, which is the system
working — but after the user hit them, not before.

**Consequence to accept**: this adds a live-verification step between "the frontend compiles" and
"the frontend is done". That is the point.
