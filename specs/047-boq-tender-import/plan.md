# Implementation Plan: Tender BOQ Import — Every Schedule, Pricing Basis, Safe Confirm

**Branch**: `047-boq-tender-import` | **Date**: 2026-10-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/047-boq-tender-import/spec.md`

## Summary

Extend 008's two-step BOQ import so it reads every schedule sheet, classifies each as item-rate or
percentage, drops tax/total rows into an "excluded rows" list, reconciles each schedule on its own and
blocks confirm on a mismatch, asks for an explicit quoted-percentage choice when the file and project
disagree, and can replace an untouched BOQ. Persist a per-line `pricingBasis` (new enum, default
`percentage`) and route every quoted-amount computation through one predicate,
`takesQuotedPercentage(line)` — `!nonBoq && pricingBasis === 'percentage'`. Add `DELETE
groups/:groupId` for empty sections. The web import screen, BOQ tree, manual line form and the
pricing screens follow.

## Technical Context

**Language/Version**: TypeScript 5 (NestJS 10 API; Next.js web in `buildcore-web`)

**Primary Dependencies**: Prisma 5.22, class-validator, SheetJS (vendored, `.xls` read only — unchanged boundary), exceljs, Zod (web)

**Storage**: PostgreSQL, `projects` schema; one additive enum column on `BOQTaskItem`

**Testing**: Jest unit specs colocated; `test/*.e2e-spec.ts` against a scratch database (`buildcore_047`, cloned from `buildcore_scratch`)

**Target Platform**: Render (API), Vercel (web)

**Project Type**: web service + web app (two repos)

**Performance Goals**: confirm stays two insert statements plus at most two delete statements (replace) inside the transaction — no per-group round trips (008's 2026-10-04 P2028 lesson)

**Constraints**: the largest fixture (Cyber Thana, ~400 rows) validates in well under a second; no new dependency

**Scale/Scope**: ~10 API files, ~8 web files, 1 migration

## Constitution Check

| Principle | Status |
|---|---|
| I. Schema-per-module | PASS — all reads/writes stay in `projects` (BOQ, client bills, packages). Inventory soft links are deliberately **not** queried for replace-blocking (spec Clarifications). |
| II. Validated DTOs | PASS — `ConfirmBoqImportDto` gains `quotedPercentageSource` (`@IsIn`) and `replaceExisting` (`@IsBoolean`); `CreateBoqItemDto` / `PlanBoqItemDto` gain `pricingBasis` (`@IsEnum`); Swagger documented. |
| III. No hardcoded values | PASS — error codes in `boq-error-codes.ts`; summary-row patterns in one module (`summary-rows.ts`); tolerance stays in config. |
| IV. Tenant isolation | PASS — every query through `withRlsContext`; no new table, so no new RLS policy. Replace and group delete audited (destructive actions). |
| V. Auth | PASS — new route behind `JwtAuthGuard`, `PermissionsGuard(PROJECTS)`, `ProjectLockGuard`. |
| VI. Safe migrations | PASS — additive migration generated with `prisma migrate dev --create-only` against the scratch DB; never run against production. |
| SheetJS boundary | PASS — reader unchanged; it already returns all sheets. |

Post-design re-check: unchanged, PASS.

## Project Structure

### Documentation (this feature)

```text
specs/047-boq-tender-import/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md, tasks.md
├── contracts/boq-import.md
└── checklists/requirements.md
buildcore-web/specs/047-boq-tender-import/   # web-side spec + tasks (web convention)
```

### Source Code

```text
buildcore-api/
├── prisma/schema.prisma                         # enum BoqPricingBasis, BOQTaskItem.pricingBasis
├── prisma/migrations/20261028100000_boq_pricing_basis/
├── src/projects/boq/
│   ├── schedule-block.ts        # identifySchedules(): every sheet, with basis
│   ├── summary-rows.ts          # NEW: tax/total row classification
│   ├── pricing-basis.ts         # NEW: takesQuotedPercentage()
│   ├── boq-import.service.ts    # per-schedule parse/reconcile, blockers, quoted choice, replace
│   ├── import-batch.store.ts    # StagedItem.pricingBasis, batch.replaceExisting info
│   ├── boq.service.ts           # deleteGroup, basis on create/plan, view carries basis
│   ├── boq.controller.ts        # DELETE groups/:groupId; confirm DTO fields
│   ├── boq-error-codes.ts
│   └── dto/boq.dto.ts
├── src/projects/billing/
│   ├── client-bills.service.ts  # compose, billableBoq, view
│   ├── certified-lines.ts
│   └── package/bill-package.service.ts (+ certified-copy reader line type)
├── test/fixtures/tenders/*.xls  # the real files
└── test/boq-tender-import.e2e-spec.ts

buildcore-web/
├── app/lib/api/projects.ts, app/lib/api/billing*.ts   # Zod schemas
├── app/ui/projects/boq-import.tsx, boq-tree.tsx (+ line form)
└── app/ui/projects/bill-sheet.tsx, bill-line-row.tsx, award-editor.tsx, bill-lifecycle.tsx
```

**Structure Decision**: existing two-repo layout; no new module.

## Complexity Tracking

None.
