# Feature Specification: Client Retention, CPBG Tracking and Project Types (Government / Private)

**Feature Branch**: `047-boq-tender-import` (shipped on the same branch and PRs, at the coordinator's instruction)
**Created**: 2026-10-28
**Status**: Implemented

**Input** (the user, verbatim): "Feature: Client Retention, CPBG tracking, and Project Types (Government / Private). Background: We're a construction company. When clients pay our bills (RA/running bills), they often hold back part of the amount: Retention money: a percentage (e.g. 5–10%) withheld from each client payment and released after completion or the defect liability period. (which we already have) CPBG (Contract Performance Bank Guarantee): a performance security we give the client for the contract. Sometimes the client deducts it from our payments instead, until a BG is submitted. Today, client payments don't capture these deductions, so we can't see how much money the client is holding. Also, projects are of two types, Government and Private, and each type needs different documents."

## What exploring the codebase found

- **No client-payment record existed.** A client bill went `draft → submitted → certified` and stopped. `Revenue` (received / pending) is written only by the dev seed; nothing in the product records money coming back. Subcontractor payments already had `RABillPayment` + `RetentionRelease`, which this mirrors.
- **Retention exists as a bill term, not as money held.** `Project.clientRetentionFraction` (023) prices a bill's retention; `ClientBill.retentionAmount` and the package's `retentionAmount` / `performanceSecurity` columns are what the *bill* deducts. None records what the client actually withheld when it paid, or released later.
- **No CPBG field** on a project — the client sheet's "Client CPBG %" was not loaded for that reason.
- **PBGs live in the 037 register**: `BankGuarantee` (type `PBG`, status `RUNNING`) under a `BgTender` that may link to a project.
- **Project type was free text.** `departmentType` / `projectType` are strings; the data loads wrote "Government" / "Private" into `departmentType`.
- **Document requirements are one set per company** (`ProjectDocumentRequirement`), falling back to six shipped kinds, read by readiness and by the creation gate.

## Requirements

- **FR-001** A project has a type: Government or Private (`Project.sector`, nullable). Existing "Government" / "Private" text moves into it.
- **FR-002** A project has a client CPBG term (`clientCpbgFraction`), like the retention term.
- **FR-003** Money received against a client bill is recorded with what the client withheld: retention, CPBG, TDS, other (with a note). The receipt says how much of the bill it settles. The bill shows its value, settled and outstanding.
- **FR-004** Each project shows what the client holds: retention withheld / released / held, CPBG deducted / refunded / held, and the total.
- **FR-005** Retention releases and CPBG refunds are recorded (append-only, with a reason), never above what is held. A CPBG refund can name the PBG that triggered it.
- **FR-006** Once a PBG is running for the project, CPBG is no longer suggested on new receipts and any CPBG still held is flagged "refund due".
- **FR-007** Which document kinds a project must hold depends on its type: per-kind Government / Private flags on the company's requirement set, with type-aware shipped defaults. Readiness and the creation gate use them.
- **FR-008** A report lists, per project, what each client holds.
- **FR-009** Receipts, removals and releases are audited.

## Clarifications (decision log)

### Session 2026-10-28 — decided by implementer; the user asked for no clarification rounds

- Q: A new project-type field, or reuse `departmentType` / `projectType`? → A: A new nullable enum `Project.sector` (`government` | `private`). The migration backfills it from `departmentType` or `projectType` when either holds only "Government"/"Govt"/"Private"/"Pvt" (any case or spacing). It clears that free-text value only when it was nothing but the type word; a real department ("PWD") stays. (decided by implementer, 2026-10-28, a typed field can drive document rules; free text cannot. Clearing the moved word stops the form showing it twice)
- Q: Is the type required? → A: Optional in the API, with an explicit choice on the web form. An untyped project is held to every document kind. (decided by implementer, 2026-10-28, existing API callers and data loads keep working, and an untyped project can never look more ready than before 048)
- Q: Where are client payments recorded? → A: A new `ClientBillReceipt` against a client bill: `amount` received plus `retentionAmount`, `cpbgAmount`, `tdsAmount`, `otherDeduction` (+ note), instrument, reference. (decided by implementer, 2026-10-28, nothing recorded client payments, and the RA-side `RABillPayment` is the established shape)
- Q: What may a bill's receipts settle in total? → A: The bill value, in this order. If the bill has a package past draft, it is the package's work done plus CGST, SGST and IGST (the invoice the client got). Otherwise it is the certified amount, or failing that the billed gross. Receipts beyond it are refused (`CLIENT_RECEIPT_EXCEEDS_BILL`), and receipts against a draft are refused. (decided by implementer, 2026-10-28, catches double entries and typed digits; the basis is reported so the figure can be checked)
- Q: How are a receipt's retention and CPBG pre-filled? → A: Retention comes from the package's retention, else the bill's own `retentionAmount`, else gross × the project's retention term. CPBG comes from the package's performance security, else gross × `clientCpbgFraction`. In both cases, less what earlier receipts on the bill already withheld, and CPBG is suggested at nil while a PBG is running. The person can change both. (decided by implementer, 2026-10-28, the receipt records what the client actually did; terms only suggest)
- Q: Is a CPBG deduction refused while a PBG is running? → A: No. It is recorded if entered, CPBG is suggested at nil, and the held CPBG is flagged "refund due". (decided by implementer, 2026-10-28, the record must match what the client actually deducted; refusing reality would leave the books wrong)
- Q: Which PBG counts as "submitted"? → A: A `BankGuarantee` of type PBG, status RUNNING, with a BG number, on a tender linked to the project. A CPBG refund may name it; only such a guarantee is accepted. (decided by implementer, 2026-10-28, links to the 037 register instead of a parallel record)
- Q: Are held balances stored? → A: No. They are derived on read from receipts and releases, as `RABillPayment` does. (decided by implementer, 2026-10-28, a stored balance goes wrong silently on the first correction)
- Q: Can a receipt be removed? → A: Yes, audited. It is refused (`CLIENT_RECEIPT_RELEASED_AGAINST`) when releases or refunds already exceed what the remaining receipts withheld. (decided by implementer, 2026-10-28, entry mistakes need a correction path that cannot orphan a release)
- Q: Permissions? → A: `PROJECT_FINANCIALS` for receipts, holdings and releases, the same as client bills. Writes go through `ProjectLockGuard`. (decided by implementer, 2026-10-28)
- Q: Where is "held by client" shown? → A: As a panel on the project overview, on the client bill screen (receipts and outstanding), and in a new "Held by client (retention & CPBG)" report under Reports. (decided by implementer, 2026-10-28)
- Q: Which document kinds per type? → A: Government needs LOI, work order, insurance, mining permission, labour insurance, BOQ and a new declared kind AGREEMENT ("Contract agreement"). Private needs work order (which covers a PO), insurance, labour insurance and BOQ. These are the shipped defaults. A company's own set carries `forGovernment` / `forPrivate` per kind, both defaulting to true so existing configurations are unchanged. (decided by implementer, 2026-10-28, per the coordinator's suggested sets)
- Q: What happens to a company that already configured its own requirement set? → A: The migration gives its LOI, MINING_PERMISSION and AGREEMENT rows `forPrivate = false`, the shipped per-type defaults. Every other row keeps both flags, so government and untyped projects are held to exactly what they were before. (decided by implementer, 2026-10-28, otherwise a private project in a configured company would be asked for an LOI until someone edits the settings)
- Q: Is the PBG/CPBG a project document kind? → A: No. It stays in the bank-guarantee register (037), which already holds the instrument, its expiry alerts and its documents. The held-by-client panel lists running PBGs. (decided by implementer, 2026-10-28, two homes for one guarantee would disagree)
- Q: Project detail or a separate endpoint for holdings? → A: A separate `GET /projects/:id/client-holdings`, so it can require `PROJECT_FINANCIALS` while the project overview does not. (decided by implementer, 2026-10-28)
- Q: Where does this ship? → A: On branch `047-boq-tender-import` and PRs #65 / #55, as instructed. (decided by coordinator)

## API

- `GET  /projects/client-bills/:id/receipts` — bill value and its basis, settled, outstanding, receipts, suggested deductions, `pbgRunning`.
- `POST /projects/client-bills/:id/receipts` — record (`RecordClientReceiptDto`).
- `DELETE /projects/client-bills/:id/receipts/:receiptId` — remove an entry made in error.
- `GET  /projects/:id/client-holdings` — the held-by-client summary, releases, running PBGs, `cpbgRefundDue`.
- `POST /projects/:id/client-holdings/releases` — retention release or CPBG refund (`RecordClientHoldReleaseDto`).
- `POST /reports/client-holdings/run` — the report.
- `POST/PATCH /projects` accept `sector` and `clientCpbgFraction`. `PUT /projects/document-requirements` accepts `forGovernment` / `forPrivate` per row; the GET returns them.

## Migration

`20261028200000_client_holds_project_sector`. It adds the enums `ProjectSector` and `ClientHoldKind`, the columns `Project.sector` and `Project.clientCpbgFraction`, and the columns `ProjectDocumentRequirement.forGovernment` and `ProjectDocumentRequirement.forPrivate` (both default true). It creates the tables `ClientBillReceipt` and `ClientHoldRelease`, each with the standard tenant RLS policy. It adds the audit types `CLIENT_RECEIPT` and `CLIENT_HOLD_RELEASE`, and backfills `sector`. The DDL was generated by `prisma migrate diff` against the scratch database. The RLS policies and the backfill follow 037's pattern of appended SQL.

## Verification

- Unit tests:
  - kind sets per type;
  - `requirementApplies`;
  - the creation gate by type;
  - readiness query count stays constant (now three queries);
  - document-type scope.
- e2e `client-holdings` (10 cases):
  - suggestions;
  - draft refusal;
  - receipt with deductions;
  - over-settle refusal;
  - holdings;
  - PBG running → refund due → refund against the PBG;
  - removal refused after refund;
  - private vs government readiness;
  - the report row.
