# Implementation Plan: Labour Worker Edit, Site Transfer, and Contractor on Payment Sheets

**Branch**: `052-labour-worker-edit` | **Date**: 2026-10-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/052-labour-worker-edit/spec.md`

## Summary

Add `PATCH /labour/workers/:id`, which edits every registration field with registration's rules and needs `LABOUR_APPROVE` for the special rate. Add `POST /labour/workers/:id/transfer`, which moves a worker to another active site of the company from today and keeps a `LabourWorkerTransfer` history. Snapshot the contractor on each payment sheet line, print it as a Contractor column in the payment sheet workbook, and show it on the sheet screen. On the web, add Edit and Transfer to the Labour list, and add the missing fields to registration under "More details".

## Technical Context

**Language/Version**: TypeScript 5 (NestJS 10 API; Next.js web in `buildcore-web`)

**Primary Dependencies**: Prisma 5.22, class-validator, exceljs. No new dependency.

**Storage**: PostgreSQL. In the `labour` schema, one new table and one nullable column.

**Testing**: Jest unit specs colocated (`worker-edit.util.spec.ts`, `labour-worker.service.spec.ts`, `payment-sheet.rules.spec.ts`); e2e suite `test/labour-worker-edit.e2e-spec.ts` against a local `buildcore_052` (a clone of `buildcore_scratch`).

**Scale/Scope**: About 12 API files, 7 web files, 1 migration.

## Constitution Check

| Principle | Status |
|---|---|
| I. Schema-per-module | PASS. Sites come through `SitesService` and vendors through `PartnersService`, both via `LabourRefsService`. `PartnersService.listVendorsForCompany` gains `type`, an additive field. |
| II. Validated DTOs | PASS. `UpdateWorkerDto` (with `ValidateIf` so name, gender and engagement cannot be nulled), `TransferWorkerDto` and `ContractorOptionsDto`. `forbidNonWhitelisted` refuses `siteId` on the PATCH. Swagger documented. |
| III. No hardcoded values | PASS. Error codes are in `LABOUR_WORKER_ERRORS` and the editable fields in `WORKER_EDITABLE_FIELDS` (`labour.constants.ts`). The time zone comes from config. |
| IV. Tenant isolation and PII | PASS. `LabourWorkerTransfer` carries `companyId` with the standard `tenant_isolation` policy. Aadhaar and bank stay masked in responses. The audit entry lists field names, never values. |
| V. Auth | PASS. The `DAILY_WORKER_REGISTRY` guard covers the routes. The special-rate check is a service-level `permissions.includes(LABOUR_APPROVE)`, which is the documented pattern for a rule on one field of an endpoint. |
| VI. Safe migrations | PASS. The migration is additive with no backfill. It was generated with `prisma migrate diff` against the local DB, plus the RLS policy, and applied locally only. |

## Design

### Edit (`src/labour/workers/`)

- `worker-edit.util.ts` holds `planWorkerEdit(current, input)`, which is pure. It applies omitted vs `null`, stores blank text as null, clears the contractor for a direct worker, and returns the next values and the names of the changed fields.
- `LabourWorkerService.update` works as follows:
  1. `loadForWrite` checks scope and the assigned site.
  2. It plans the edit and, if nothing changed, returns the detail.
  3. It checks the rate permission, a contractor required for contractor engagement, a newly named contractor through `assertActiveContractor`, and the skill.
  4. In the transaction it checks the Aadhaar clash among other active workers and updates only the changed columns.
  5. It audits `{ fields }`.
- `create` also checks the rate permission.
- `findOne` and `update` return `WorkerDetail` with `contractorName`, `dateOfBirth` and `transfers`. `findAll` resolves contractor names for the page.

### Transfer

- `LabourWorkerService.transfer` validates: the worker is active, the site differs, the site belongs to the same company (`refs.findSite`), the site is active, and the caller holds both sites.
- In one transaction it then:
  1. refuses if the latest punch is an `in` from today or yesterday;
  2. ends the active gang membership;
  3. writes `LabourWorkerTransfer` with `transferredOn` set to today (company zone);
  4. updates `siteId`.
- Then it audits.
- `worker-site.ts` holds `siteOnDate(tx, worker, date)`: the earliest transfer after the date gives its `fromSiteId`, otherwise the current site. `MusterAttendanceService.correct` and `history` use it for a day with no punch.

### Payment sheets

- `buildLines` writes `contractorId` on each line, wage and carry-forward lines alike, as `null` for direct workers. A new helper, `daysOnOtherSheets`, finds the same site's live sheets of the other engagement type that already carry the worker. Muster lines on those sheets' dates are skipped.
- `payment-sheet.rules.ts` holds `lineContractorId(sheet, line, worker)`: the snapshot if present, else the worker's current contractor on a contractor sheet, else null.
- `PaymentSheetService.findOne` adds `contractorId` and `contractorName` to each line.
- `LabourSheetsService.paymentSheet` inserts a Contractor column after Gender. Widths and number formats shift by one, and the totals row gets one more blank cell.

### Web (`buildcore-web`)

- `app/lib/api/labour.ts`: `contractorName` on workers and sheet lines; `dateOfBirth` and `transfers` on the detail; `updateWorker`, `transferWorker` and `getContractorOptions`.
- `app/ui/labour/worker-details-fields.tsx`: shared fields for engagement, contractor picker, skill, date of birth, Aadhaar and bank (masked, with replace or remove), and special rate (`LABOUR_APPROVE` only).
- `app/ui/labour/worker-edit-forms.tsx`: `EditWorkerForm`, which sends only the changed fields and warns about price changes, and `TransferWorkerForm`.
- `app/dashboard/labour/workers/page.tsx`: the Contractor column, Edit and Transfer actions, father's name and mobile under the name, and status, face and NOC stacked.
- `app/labour/register/page.tsx`: a collapsible "More details" section.
- `app/dashboard/labour/payment-sheets/[id]/page.tsx`: the contractor under the worker's name.
- `app/ui/settings/responsive-list.tsx`: row actions wrap.

## Risks

- **Rates and gender are not dated.** An edit reaches every sheet generated afterwards for its whole period. This is documented in the spec, and the edit form says it.
- **Transfer and punch race.** A punch that started before the transfer's check could still land at the old site. The window is milliseconds, and the day would then simply belong to the old site.
