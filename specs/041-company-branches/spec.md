# Feature Specification: Company Branches (Multiple GST Registrations per Company)

**Feature Branch**: `041-company-branches`

**Created**: 2026-10-22

**Status**: Draft

**Input**: User description: "Under one company we have multiple registered offices and GST numbers — one company, one GSTIN per state, each with its own address, contact details and PF establishment code. Projects bill from a branch, employees belong to a branch, and PF/ESIC are filed per branch. Numbering stays one series per company."

## Background

Today a company carries exactly one GSTIN and one address, and every outgoing document prints those.
The client's two companies do not fit that shape:

| Company | Kind | PAN | GST registrations (state code — place) |
|---|---|---|---|
| Parth Realcon Private Limited (PRPL) | Private limited (CIN registered in Rajasthan) | AAMCP8659H | 08 Rajasthan — Deoli (head office), 07 Delhi, 27 Maharashtra — Hingoli, 09 Uttar Pradesh — Shahjahanpur, 24 Gujarat — Godhra |
| Tirupati Enterprises (TE) | Proprietorship (no CIN) | AFOPJ3554P | 08 Rajasthan — Deoli (head office), 06 Haryana — Rewari, 27 Maharashtra — Washim, 09 Uttar Pradesh — Shahjahanpur, 24 Gujarat — Godhra, 10 Bihar — Aurangabad, 23 Madhya Pradesh — Mandsaur |

Within a company, the legal name, short code, PAN, CIN and TAN are the same on every registration.
The GSTIN, address, contact details and, for TE, the PF establishment code (RJRAJ1296202 … 207)
differ per registration. In the client's data collection workbook each registration is a separate
row of the Companies tab, all sharing one short code.

This feature calls each registration a **branch**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Record a company's branches (Priority: P1)

An administrator opens a company's settings and sees its branches: one per GST registration, each
with its GSTIN, address, city, state, PIN, phone, email, website, PF establishment code, ESIC code
and professional tax registration number. Exactly one branch is marked as the head office (the
default). The administrator can add a branch, edit one, mark a different branch as head office, or
deactivate a branch that is no longer used.

**Why this priority**: Every other story reads branches. Without them, nothing else can be done.

**Independent Test**: Add PRPL's five registrations as branches, mark Deoli as head office, and
confirm the list shows five branches with Deoli as the default. Then try to add a sixth branch with
an invalid GSTIN and confirm it is refused with a clear reason.

**Acceptance Scenarios**:

1. **Given** a company with only its migrated head-office branch, **When** an administrator adds a branch with GSTIN `07AAMCP8659H1ZQ`, state Delhi and a Delhi address, **Then** the branch is saved and listed beside the head office.
2. **Given** a company whose PAN is `AAMCP8659H`, **When** a branch is added with a GSTIN whose characters 3–12 are a different PAN, **Then** it is refused with a message saying the GSTIN does not belong to this company's PAN.
3. **Given** a branch with state Gujarat, **When** its GSTIN starts with `08`, **Then** it is refused with a message saying the GSTIN's state code (08, Rajasthan) does not match the branch's state.
4. **Given** a company that already has a branch with GSTIN `24AAMCP8659H1ZU`, **When** another branch is entered with the same GSTIN, **Then** it is refused as a duplicate.
5. **Given** a company with head office Deoli, **When** the administrator marks the Delhi branch as head office, **Then** Delhi becomes the only default branch and Deoli stops being default.
6. **Given** the head-office branch, **When** an administrator tries to deactivate it, **Then** it is refused; another branch must be made head office first.

---

### User Story 2 - A project bills from its branch (Priority: P1)

When a project is created or edited, the user chooses which branch it belongs to. If they choose
nothing, the head office is used. Every outgoing document raised for that project prints that
branch's GSTIN and address as the issuer or as the "bill to" party, instead of the company's single
address. This covers RA bills, debit notes, hire bills, payment advice, and purchase, work and hire
orders. The CGST+SGST or IGST split stays the project's choice; the check that warns when the
parties' states disagree with it now uses the branch's GSTIN.

**Why this priority**: This is the reason the feature exists. Billing a Gujarat site from the
Rajasthan GSTIN is a wrong tax invoice, and a vendor invoicing the wrong GSTIN costs the company its
input tax credit.

**Independent Test**: Assign a project to PRPL's Gujarat branch, issue an RA bill to a client with a
Gujarat GSTIN, and confirm the bill shows GSTIN `24AAMCP8659H1ZU` and the Godhra address, with no tax-basis
warning on a CGST+SGST project. Then issue a purchase order on the same project and confirm its "bill to" block shows the
Gujarat GSTIN and address.

**Acceptance Scenarios**:

1. **Given** a project with no branch chosen, **When** an RA bill is issued, **Then** the issuer GSTIN, state and address are the head office's.
2. **Given** a project on the Gujarat branch set to CGST+SGST and a client whose GSTIN starts with `24`, **When** an RA bill is composed, **Then** no tax-basis warning is shown (both parties are in state 24).
3. **Given** a project on the Gujarat branch set to CGST+SGST and a client whose GSTIN starts with `08`, **When** an RA bill is composed, **Then** the bill warns that the parties are in different states (24 and 08) — the tax is still the project's choice.
4. **Given** an RA bill already issued from the head office, **When** the project is moved to the Gujarat branch, **Then** the issued bill still shows the head office GSTIN and address, and only bills issued after the move show Gujarat.
5. **Given** a project on the Maharashtra branch, **When** a purchase order, work order or hire order is printed, **Then** its buyer / "bill to" block shows the Maharashtra GSTIN and address.
6. **Given** a project on the Delhi branch, **When** documents are numbered, **Then** they continue in the company's single series. There is no separate series per branch.

---

### User Story 3 - Employees belong to a branch, and PF/ESIC are filed per branch (Priority: P2)

Each employee is assigned to a branch of their company, chosen on the employee record. The head
office is the default. Statutory payroll outputs (the PF, ESIC and professional tax challans and
the monthly statutory register) can be produced for one branch at a time. Each output carries that
branch's PF establishment code, ESIC code or PT registration number and includes only that branch's
employees.

**Why this priority**: PF and ESIC are filed separately for each establishment code. A single
company-wide challan cannot be filed when the codes differ, as TE's do. This comes after billing
because payroll can keep running company-wide in the meantime.

**Independent Test**: Put two TE employees on the Rajasthan branch (PF code RJRAJ1296202) and one on
the Haryana branch (RJRAJ1296203). Process a payroll run, then produce the PF challan for each
branch. Confirm each challan carries its own code and only its own employees, and that the two
together add up to the company total.

**Acceptance Scenarios**:

1. **Given** a new employee with no branch chosen, **When** they are saved, **Then** they belong to the head office.
2. **Given** an employee, **When** their branch is changed, **Then** later payroll runs report them under the new branch.
3. **Given** a processed payroll run with employees on two branches, **When** the PF challan is requested for one branch, **Then** it lists only that branch's employees, shows that branch's PF establishment code, and its totals equal those employees' figures.
4. **Given** the same run, **When** the challan or register is requested for all branches, **Then** the totals equal the sum of the per-branch outputs.
5. **Given** a processed run, **When** an employee's branch is changed afterwards, **Then** that run's per-branch outputs do not change. An employee is reported under the branch they were on when the run was processed.
6. **Given** a branch with no PF establishment code (TE Madhya Pradesh), **When** its PF output is requested, **Then** it is produced with the code shown as blank and a visible warning that the code is missing. It is not refused.

---

### User Story 4 - Existing data and the client workbook move over without loss (Priority: P1)

When the feature ships, every existing company gets one head-office branch made from its current
GSTIN, address and statutory codes. Every existing project and employee is assigned to it. Nothing
already printed or issued changes. When the client's data collection workbook is imported, rows on
the Companies tab that share a short code become one company with one branch per row.

**Why this priority**: Without migration, every existing project and employee would have no branch
on release day. Without importer grouping, the client's PRPL and TE rows cannot be loaded at all,
because short codes are unique.

**Independent Test**: On a copy of the development database, apply the migration. Confirm each
company has exactly one head-office branch matching its old fields, and that every project and
employee is on it. Re-render an issued bill and confirm it matches the original byte for byte.
Import the client's Companies tab and confirm PRPL has 5 branches and TE has 7, with Deoli as head
office for both.

**Acceptance Scenarios**:

1. **Given** a company with GSTIN `08AFOPJ3554P1ZQ` and a Deoli address before the release, **When** the migration runs, **Then** the company has one head-office branch with that GSTIN and address, and all of its projects and employees point to it.
2. **Given** a company with no GSTIN before the release, **When** the migration runs, **Then** it still gets one head-office branch, with the GSTIN left empty.
3. **Given** the client workbook's Companies tab with five PRPL rows, **When** it is imported, **Then** one company PRPL is created with five branches. The company-level fields (legal name, PAN, CIN, TAN, rates, payroll settings) come from the head-office row.
4. **Given** the five PRPL rows, **When** the head office is chosen during import, **Then** it is the row whose state matches the state in the CIN (Rajasthan for `U70109RJ…`). For a company without a CIN, such as TE, it is the first row.
5. **Given** rows sharing a short code but disagreeing on PAN or legal name, **When** imported, **Then** the import stops and names the conflicting rows. It does not pick one silently.
6. **Given** a migration that has already run, **When** it runs again, **Then** it creates no second head-office branch.

---

### Edge Cases

- **A project's branch is deactivated.** Existing projects and employees on it keep it, and their documents still print it. A deactivated branch cannot be chosen for a new project or employee.
- **A company has only one branch.** Branch selectors are hidden. Behaviour is identical to today.
- **A branch with no GSTIN** (an unregistered head office). Documents print no GSTIN line, as they do today when the company has none. The tax basis falls back to the project's existing intra/inter-state setting, as it does today.
- **Two branches in the same state.** Allowed, provided the GSTINs differ (GST permits more than one registration per state).
- **Company PAN missing.** A GSTIN is still checked for format and state code. The PAN-match check is skipped until a PAN is recorded.
- **An employee moves branch mid-month.** The run reports them under the branch they were on when it was processed (US3 scenario 5). The month is not split.
- **Letters and other company-level documents** with no project (offer letters, general correspondence) use the head office, unless the document is about an employee. Then it uses the employee's branch address.
- **Payslips** show the employee's branch address.
- **A purchase order or other letter with no project or employee** defaults to the head office. The person composing it may choose another active branch.
- **Client and vendor records** are unaffected. Their GSTIN and state handling is unchanged.

## Requirements *(mandatory)*

### Functional Requirements

**Branches**

- **FR-001**: A company MUST be able to have one or more branches. Each branch records: GSTIN (optional), a short label shown when choosing a branch (optional, defaulting to "City (State)"), a printed trade name (optional, defaulting to the company's legal name), address, city, state, PIN code, phone, email, website, PF establishment code, ESIC code, and professional tax registration number.
- **FR-002**: Each company MUST have exactly one head-office (default) branch at all times.
- **FR-003**: A branch GSTIN, when present, MUST be 15 characters in the GSTIN format. Its first two characters MUST be the GST state code of the branch's state. When the company has a PAN, characters 3–12 MUST equal that PAN. Each check MUST fail with its own clear message.
- **FR-004**: A GSTIN MUST be unique among the branches of a company.
- **FR-005**: Users with permission to edit company settings MUST be able to add, edit, deactivate and reactivate branches, and to change which branch is head office. The head office cannot be deactivated.
- **FR-006**: The company's legal name, short code, PAN, CIN, TAN, statutory rates and payroll settings MUST stay at company level and MUST NOT vary by branch.

**Projects and documents**

- **FR-007**: Each project MUST belong to one active branch of its company. It MUST default to the head office when none is chosen, and MUST be changeable later.
- **FR-008**: Every outgoing document raised for a project MUST print that project's branch GSTIN, state and address wherever it prints the company's GSTIN, state or address today. That means as the issuer on RA bills, debit notes, hire bills and payment advice, and as the buyer / "bill to" party on purchase, work and hire orders.
- **FR-009**: The intra/inter-state tax basis stays the project's own choice (CGST+SGST or IGST, decided 2026-10-14). The check that warns when the two parties' registrations point the other way MUST compare the project's **branch** GSTIN with the counterparty's, not the head office's. *(Corrected during implementation: the spec originally said the basis is derived from the GSTINs, which the 2026-10-14 project-flag decision had already replaced.)*
- **FR-010**: Documents that record issuer details at issue (RA bills and issued letters) MUST keep what they recorded. Changing a project's branch, or editing a branch, MUST NOT alter them. Documents that read the company live today (debit notes, payment advice, store documents, hire orders and bills, payslips) MUST read the project's or employee's current branch the same way. They follow a branch change exactly as they follow a company edit today. *(Narrowed during planning, research R5.)*
- **FR-011**: Document numbering MUST remain one series per company, unaffected by branches.
- **FR-012**: Company-level documents not tied to a project MUST use the head office. A document about a specific employee MUST use that employee's branch.

**Employees and statutory payroll**

- **FR-013**: Each employee MUST belong to one active branch of their company, chosen on the employee record, defaulting to the head office.
- **FR-014**: When a payroll run is processed, each employee's branch at that moment MUST be recorded with their figures. Later per-branch outputs for that run MUST use the recorded branch.
- **FR-015**: The PF, ESIC and professional tax challans and the monthly statutory register MUST be producible for a single branch. Each MUST then include only that branch's employees and show that branch's PF establishment code, ESIC code or PT registration number.
- **FR-016**: The same outputs MUST remain producible for the whole company, with totals equal to the sum of the per-branch outputs.
- **FR-017**: When a branch lacks the code a statutory output needs, the output MUST still be produced, with the code blank and a visible warning.
- **FR-018**: TDS outputs MUST remain company-level, under the company TAN.

**Migration and import**

- **FR-019**: On release, each existing company MUST receive exactly one head-office branch populated from its current GSTIN, address, city, state, PIN, phone, email, website and statutory codes. All of its existing projects and employees MUST be assigned to it. Re-running the migration MUST NOT create duplicates.
- **FR-020**: The existing company-level GSTIN, address and code fields MUST be kept, not removed, during this release.
- **FR-021**: The client data importer MUST treat Companies-tab rows that share a short code as one company with one branch per row.
- **FR-022**: During import, the head office MUST be the row whose state matches the CIN's state code. When there is no CIN, it MUST be the first row for that short code.
- **FR-023**: The import MUST refuse, naming the rows, when rows sharing a short code disagree on any company-level field (legal name, PAN, CIN, TAN).
- **FR-024**: The client data collection workbook template MUST state that a company with several GST registrations is entered as one row per registration, sharing a short code.

### Key Entities

- **Company**: The legal entity. It holds legal name, short code, PAN, CIN, TAN, statutory rates and payroll settings, and has one or more branches.
- **Branch** (GST registration / place of business): Belongs to one company. It holds GSTIN, address, city, state, PIN, phone, email, website, PF establishment code, ESIC code and PT registration number. It has an active/inactive status, and one branch per company is the head office.
- **Project**: Gains a reference to the branch it bills from.
- **Employee**: Gains a reference to the branch they belong to.
- **Processed payroll line**: Records the employee's branch at processing time, so per-branch outputs for that run are stable.
- **Issued documents** (RA bill, debit note, hire bill, payment advice, orders): Continue to record issuer or buyer details at issue. The source is now the project's branch.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The client's two companies load from their workbook as 2 companies with 12 branches in total (PRPL 5, TE 7), with no manual re-entry.
- **SC-002**: 100% of RA bills, debit notes, hire bills, payment advice and orders issued after release on a non-head-office project show that branch's GSTIN and address.
- **SC-003**: On every bill whose branch and client GSTINs are both present, the tax-basis warning compares the branch's state (not the head office's) with the client's, in 100% of cases.
- **SC-004**: Every document issued before release renders identically after release.
- **SC-005**: For any processed run, the per-branch PF, ESIC and PT totals add up exactly to the company total.
- **SC-006**: An administrator can add a new branch and move a project onto it in under 2 minutes.
- **SC-007**: Companies with a single branch see no change in any workflow or document.

## Assumptions

- "Registered office" in the request means a GST place of business. A company has one legal registered office, which is its head-office branch here.
- Bank accounts (salary debit account, bank guarantees, payment files) stay company-level. Per-branch bank accounts are out of scope.
- Letterhead and logo images stay company-level. Per-branch letterheads are out of scope.
- E-invoicing and e-way bill integration are out of scope. This feature only ensures the right GSTIN and address are printed and recorded.
- Branch management uses the existing company-settings permission. No new permission is introduced.
- Client and vendor master data are unchanged.
- The BOCW registration number and labour (daily-wage) attendance remain company-level and project-level as today.
- Feature 040 (monthly statutory register) is the register that gains the per-branch filter. If 040 has not merged when this is implemented, the per-branch filter applies to it on merge.
