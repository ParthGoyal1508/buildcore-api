# Quickstart: validating Company Branches (041)

## Prerequisites
- A local database migrated to this branch (`npx prisma migrate dev`) and seeded (`npm run seed:dev`).
- The API (`npm run start:dev`) and the web app (`buildcore-web`, `npm run dev`) running.
- Signed in as Super Admin.

## 1. The migration is lossless (US4, SC-004)
1. Before migrating, render one issued RA bill PDF, one debit note and one payslip, and save them.
2. Migrate.
3. Every company has exactly one branch where `isHeadOffice`. Its GSTIN and address equal the old
   Company columns, and every project and employee has that branch's `branchId`.
4. Re-render the three documents from step 1. The bill must be byte-identical; the others visually
   identical.
5. Run the migration SQL a second time. It must still leave exactly one head office per company.

## 2. Manage branches (US1)
In Settings → Companies → PRPL → Branches:

| Action | Expected |
|---|---|
| Add Gujarat with `24AAMCP8659H1ZU`, Godhra, PIN 389001 | Saved |
| Add Gujarat with `08AAMCP8659H1ZO` | Refused with the state-code message |
| Add a branch whose GSTIN carries another PAN | Refused with the PAN message |
| Add the same GSTIN twice | Refused as a duplicate |
| Deactivate the head office | Refused |
| Make Delhi head office, then back | Exactly one head office each time; the Company PATCH response mirrors it |

## 3. Billing from a branch (US2, SC-002, SC-003)
1. Set a project to the Gujarat branch.
2. With the project set to CGST+SGST, compose an RA bill to a client whose GSTIN starts with `24`.
   The header shows `24AAMCP8659H1ZU` and Godhra, and there is no tax-basis warning.
3. Repeat with a client whose GSTIN starts with `08`. The bill warns that the parties are in
   different states (24 and 08); the tax is still the project's choice (2026-10-14 rule).
4. Move the project to Rajasthan. Re-open the bills from steps 2–3: they are unchanged. A new bill
   shows Rajasthan.
5. On that project, issue a work order letter and print a GRN. Both show the project's branch.
6. Compose a PO letter with no project. The branch picker defaults to the head office; pick
   Maharashtra and the PO prints the Maharashtra GSTIN.
7. Document numbers continue the single company series.

## 4. Payroll per establishment (US3, SC-005)
1. In TE: put employee A on Rajasthan (RJRAJ1296202) and B on Haryana (RJRAJ1296203). Process the
   month.
2. The Challans page, filtered to Haryana, shows only B, with code RJRAJ1296203.
3. The Rajasthan total plus the Haryana total equals the unfiltered total.
4. Move B to Rajasthan. The processed month's Haryana challan still shows B.
5. Filter to Madhya Pradesh (no PF code). The page is produced with a blank code and a warning.
6. The statutory register exported with `branchId=Haryana` has the Rewari address and Haryana codes
   on the establishment line.
7. B's payslip shows the Rewari address.

## 5. Client workbook import (US4, SC-001)
1. `npx ts-node scripts/import-client-companies.ts docs/<client-workbook>.xlsx` prints a plan of
   2 companies and 12 branches. PRPL's head office is the Deoli (08) row; TE's is the first row
   (Deoli).
2. Run it with `--apply`, then run it again. The second run reports no changes.
3. Edit one PRPL row's PAN in a copy of the workbook. The script exits non-zero and names the rows.

## Automated
- `npm test -- companies branch` covers branch validation, head-office swap and mirroring.
- `npm test -- bill-package bill-tax` covers the branch issuer and tax basis.
- `npm test -- challans statutory-register payroll-engine` covers line stamping and filters.
- `npm test -- import-client-companies` covers grouping, head-office choice and conflicts.
