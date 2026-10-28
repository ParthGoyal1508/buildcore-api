# Feature Specification: Tender BOQ Import — Every Schedule, Pricing Basis, Safe Confirm

**Feature Branch**: `047-boq-tender-import`

**Created**: 2026-10-28

**Status**: Draft

**Input**: User description: "Tender BOQ import that reads every schedule of a Rajasthan e-procurement workbook (item-rate and percentage), stores a per-line pricing basis (percentage vs item rate) so the project's quoted percentage applies only to percentage lines everywhere quoted amounts are computed, never imports tax/total/summary rows as BOQ lines (reports them as info), blocks confirm when a schedule's derived totals don't reconcile with its stated totals, requires an explicit choice when the file's quoted percentage differs from the project's, allows replacing an existing BOQ when none of its lines is measured/billed/used in a DWR/awarded, and allows deleting an empty BOQ group. Web import screen, BOQ view and manual line add/edit updated accordingly."

## Background

Rajasthan e-procurement tender workbooks (template `BoQ_Ver3.0`, legacy `.xls`) carry one sheet per
schedule — `BoQ1`, optionally `BoQ2` — plus a `Macros` sheet. Row 1 of each schedule names its type:
**"Item Rate BoQ"** (the bidder quotes a rate per line) or **"Percentage BoQ"** (the bidder quotes one
percentage above or below the schedule of rates). The footer carries `Total in Figures`,
`Quoted Rate in Figures` (direction label `Less (-)` / `Excess (+)` / `Select`, and the fraction) and
`Quoted Rate in Words`.

Importing the client's real files (24 projects) surfaced three defects in the importer built by 008:

| File | What it holds | What happened |
|---|---|---|
| `NEWAI SHAHID SMARAK/BOQ.xls` | BoQ1 item-rate ₹4.88 lakh + BoQ2 percentage ₹97.53 lakh at −19.12% (quoted ₹78,88,083) | Only BoQ1 was read; ₹97 lakh of scope was missing |
| `Cyber Thana Jhalawar/BOQ_859032.xls` | BoQ1 item-rate ₹2.59 lakh + BoQ2 percentage ₹2.89 cr at +5.67% (quoted ₹3,05,49,670) | Only BoQ1 was read |
| `MAHILA THANA TONK/BOQ_749857.xls` | BoQ1 percentage ₹2.72 cr at −4.67% + BoQ2 item-rate ₹7.90 lakh | BoQ2 missing |
| `STMC KOTA DARAH 23-24/BOQ_832999.xls` | 29 lines + "Total amount" + **"Add GST @18%"** (unit `%`, qty 18, rate = schedule total) | The GST row became a BOQ line worth ₹21 crore; totals disagreed but confirm went through |
| (several) | File quoted +7.71%, project held +7.65% | Confirm overwrote the project's figure without asking |

Item-rate lines are already priced by the bidder; applying the project's quoted percentage to them
would over- or under-bill every one.

## Clarifications

### Session 2026-10-28 (decided by implementer — the user asked for no clarification rounds)

- Q: How is a schedule's pricing basis detected? → A: From the label rows above the header ("Item Rate BoQ" / "Percentage BoQ", or the template's type cell "Item Rate" / "Percentage"); a schedule with no recognisable label is treated as percentage. (decided by implementer, 2026-10-28, percentage is today's behaviour for every existing import, so an unlabelled file imports exactly as before)
- Q: What default basis do existing BOQ lines get? → A: `percentage` for every existing row, and for a manually added line when none is sent. (decided by implementer, 2026-10-28, keeps today's billing figures unchanged for data already on projects)
- Q: Do non-BOQ items (extra items added on a bill) follow the basis? → A: No — a non-BOQ item never takes the quoted percentage, whatever its basis, as today. (decided by implementer, 2026-10-28, existing rule, unchanged)
- Q: How are line numbers kept unambiguous when two schedules both number from 1? → A: In a workbook with more than one schedule, every line and section from that workbook is prefixed with its sheet name (`BoQ2/1.01`); a single-schedule workbook is numbered exactly as today. (decided by implementer, 2026-10-28, a bill or DWR showing two different "1.01" lines cannot be reconciled; the sheet name is what the client's own documents use)
- Q: Section names in a multi-schedule workbook? → A: Prefixed with the sheet name and basis (`BoQ2 (Percentage) › WORKS`), and section numbers run continuously across schedules. (decided by implementer, 2026-10-28, the BOQ view must show which schedule a section came from)
- Q: Which rows are tax/total/summary rows? → A: Rows whose description is wholly a total label ("Total", "Total amount", "Grand Total", "Sub Total", "Total in Figures", "Total cost") or a quoted-rate label, and rows that add or levy a tax ("Add GST @18%", "GST @ 18%", "CGST…", "SGST…", "IGST…", "Add/Less … tax/cess"). Descriptions that merely mention a word ("Total station survey", "rates inclusive of GST") are lines. (decided by implementer, 2026-10-28, a loose "starts with Total" rule would drop real work items)
- Q: The STMC file's stated total includes the GST row it should not import — does that make it unreconcilable? → A: No. Reconciliation compares the stated total against the derived line total **plus** the excluded tax rows' own amounts (the file's amount column, else quantity × rate ÷ 100 for a `%` unit). The report shows the excluded amount. (decided by implementer, 2026-10-28, otherwise every tender that adds GST in the schedule would be permanently blocked, and the figure the file states really is lines + tax)
- Q: For an item-rate schedule, what is reconciled? → A: The line total against `Total in Figures` only; its `Quoted Rate in Figures` row (normally `Select` / 0) is ignored. (decided by implementer, 2026-10-28, an item-rate schedule has no percentage, and the template writes 0 there)
- Q: Is a schedule with no stated totals blocked? → A: No — nothing to reconcile against is reported as "not stated", not as a failure, as today. (decided by implementer, 2026-10-28, many hand-made workbooks carry no footer)
- Q: What happens to a batch that does not reconcile? → A: Validate still returns the full report (every figure, every row) but issues no batch to confirm: `batchId` is null, `confirmable` is false, and the blockers say which schedule failed by how much. Confirm of a stale batch is refused anyway. (decided by implementer, 2026-10-28, the review is still useful; a blocked batch would only use up the five-pending-batch quota)
- Q: Two percentage schedules with different quoted percentages? → A: Blocked — a project carries one quoted percentage. Same percentage on both is fine. (decided by implementer, 2026-10-28, no real file does this; refusing is safer than choosing)
- Q: When does the quoted-percentage choice apply? → A: Only on a tender (not estimate) import whose workbook has a located percentage that differs from the project's at six decimals — including a project still at the default 0. Confirm then requires `quotedPercentageSource: 'file' | 'project'`; without it, it is refused with `BOQ_QUOTED_PERCENTAGE_CHOICE_REQUIRED`. When equal, or when the file has no percentage schedule, nothing is asked and the project's figure is left as is. (decided by implementer, 2026-10-28, 0 is also what a project that never had a figure holds, and silently overwriting it is exactly what was reported)
- Q: Choosing "project" — is the file's reconciliation still valid? → A: Yes; reconciliation is a check that the file was read correctly and is done with the file's own percentage either way. The choice only decides what the project keeps. (decided by implementer, 2026-10-28)
- Q: What counts as a line that blocks replacement? → A: Completed quantity not zero (measured), any DWR task (used in a daily work report), any client bill line (billed), any work-order award line (awarded). Inventory issue/indent tags are optional soft links in another module and do not block. (decided by implementer, 2026-10-28, the four named in the request; inventory tags are informational and validated only when written)
- Q: How is replacement requested? → A: Validate reports `replace: { existingLines, existingGroups, replaceable }` and refuses with `BOQ_REPLACE_BLOCKED` (listing counts and line numbers) when blocked. Confirm requires `replaceExisting: true` when the project has lines; it re-checks inside the transaction, deletes the variant's existing sections and lines, and writes the new ones. (decided by implementer, 2026-10-28, an explicit flag means a confirm can never replace by accident)
- Q: Does replacing a tender touch the estimate (or vice versa)? → A: No — only the variant being imported. (decided by implementer, 2026-10-28, same scoping the import already has)
- Q: Can a line's basis be changed after it exists? → A: Yes, through the existing line edit, unless the line is on any client bill (`BOQ_PRICING_BASIS_LOCKED`). (decided by implementer, 2026-10-28, a bill's quoted rate is read through the line's basis, so changing it after billing would restate a sent bill)
- Q: Three real files (Bundi Minority Hostel, Goynda Road, STMC 2024-25) state totals ₹0.82–₹1.85 off the paisa-exact sum — block them? → A: No. Those workbooks round each line's amount to whole rupees and state the sum of the rounded lines. The tolerance is one paisa a line **plus** the file's own per-line rounding (the sum of |file amount − computed amount| over lines where that is ≤ ₹0.50); the quoted-total tolerance scales by (1 + |quoted %|). A misread row moves a line by its whole amount and still blocks. Measured: all 24 client tenders reconcile; a ₹1,000 change to a stated total blocks. (decided by implementer, 2026-10-28, blocking would make three correct tenders impossible to import)
- Q: Where do the real tender files live in the repository? → A: `test/fixtures/tenders/`, **git-ignored** like `docs/`; the fixture-backed unit and e2e tests report as skipped (with the reason) when the folder is absent. (decided by implementer, 2026-10-28, the workbooks carry the client's bids, and publishing them to the remote was refused; this matches how `docs/BOQ_794578.xls` is already handled)
- Q: Group delete — permission and lock? → A: Same as the other BOQ writes: `PROJECTS` permission and the project lock guard. A group holding any line is refused with `BOQ_GROUP_NOT_EMPTY`. (decided by implementer, 2026-10-28)

### Session 2026-10-28 (follow-up, coordinator request — "Part A")

- Q: Parth Realcon's own BOQ (Ganga Innova) is refused with `BOQ_NO_SCHEDULE_BLOCK` because its quantity column is headed "BOQ." — accept it? → A: Yes. A whole-cell "BOQ", "BOQ.", "BOQ Qty" or "BOQ Quantity" heading is a quantity heading. A lone "BOQ" title row can't be taken for the header, because a header row must still name a description, a unit and a rate. "BOQ No." is not a quantity. (decided by implementer, 2026-10-28)
- Q: Those schedules end with "Total Amount" in the description column rather than "Total in Figures" in a footer — reconcile against it? → A: Yes. "Total Amount" counts as a stated-total label, read from the footer first and then from candidate rows, where it is excluded from the lines as a total row. Every Parth Realcon custom BOQ now reconciles against its own total. Ganga Innova: 9 lines, ₹64,80,000 = stated. All 36 BOQ workbooks on file still validate as confirmable. (decided by implementer, 2026-10-28)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Import a mixed tender completely and price it correctly (Priority: P1)

A project manager uploads a tender workbook with an item-rate schedule and a percentage schedule.
The report shows each schedule separately — its sheet, its basis, its lines, its derived and stated
totals, and (for the percentage schedule) the quoted percentage. On confirm both schedules become
sections on the project; item-rate lines are billed at their own rate, percentage lines at rate ×
(1 + quoted percentage).

**Why this priority**: Missing a ₹97 lakh schedule, or pricing ₹4.88 lakh of item-rate work at −19.12%,
is a wrong bill on every RA.

**Independent Test**: Validate `NEWAI SHAHID SMARAK/BOQ.xls`; the report has two schedules (BoQ1
item-rate ₹4,88,000, 2 lines; BoQ2 percentage ₹97,52,823 at −19.12%, quoted ₹78,88,083.24). Confirm,
then the billable BOQ quoted total equals ₹4,88,000 + ₹78,88,083 (within rounding).

**Acceptance Scenarios**:

1. **Given** a two-schedule workbook, **When** validated, **Then** both schedules are reported with their basis and totals, and the line count is the sum of both.
2. **Given** the confirmed mixed BOQ, **When** a client bill measures one line of each basis, **Then** the item-rate line amount is quantity × rate and the percentage line amount is quantity × rate × (1 + quoted %).
3. **Given** the confirmed mixed BOQ, **When** the billable BOQ summary is read, **Then** the quoted total applies the percentage only to the percentage schedule.

---

### User Story 2 - Tax and total rows never become work items (Priority: P1)

A workbook adds "Add GST @18%" as a row inside the schedule. The import excludes it, shows it under
"Rows not imported" with its amount, and still reconciles because the stated total is lines + tax.

**Why this priority**: A ₹21 crore phantom line corrupts every progress and billing figure.

**Independent Test**: Validate `STMC KOTA DARAH 23-24/BOQ_832999.xls`; 29 lines, no line named GST or
Total, excluded rows include "Add GST @18%" (₹21,09,163) and "Total amount"; reconciles.

**Acceptance Scenarios**:

1. **Given** a schedule with a GST row and a "Total amount" row, **When** validated, **Then** neither is a line and both appear in the excluded-rows list.
2. **Given** an item named "Total station survey", **When** validated, **Then** it is imported as a line.

---

### User Story 3 - A schedule that does not add up cannot be confirmed (Priority: P1)

When a schedule's derived total differs from its stated total (or its quoted total from the stated
quoted total) by more than the tolerance, the report shows a blocking error naming the schedule and
the difference, and no confirm is possible.

**Independent Test**: A workbook whose stated total is changed by ₹1,000 validates with
`confirmable: false`, `batchId: null` and a blocker naming that sheet.

**Acceptance Scenarios**:

1. **Given** a non-reconciling schedule, **When** validated, **Then** the report carries a blocker and no batch.
2. **Given** every schedule reconciles, **When** validated, **Then** `confirmable` is true.

---

### User Story 4 - Choose which quoted percentage the project keeps (Priority: P2)

When the file's quoted percentage differs from the project's, the report shows both. Confirm asks
the person to pick one; without a pick, it refuses.

**Acceptance Scenarios**:

1. **Given** project −4.00% and file −19.12%, **When** confirm is sent without a choice, **Then** it is refused with `BOQ_QUOTED_PERCENTAGE_CHOICE_REQUIRED`.
2. **Given** the same, **When** confirmed with `file`, **Then** the project holds −19.12%; **with** `project`, it keeps −4.00%.
3. **Given** the two are equal, **When** confirmed with no choice, **Then** it succeeds.

---

### User Story 5 - Replace a BOQ nobody has worked against (Priority: P2)

A project manager imported the wrong file. Nothing has been measured, billed, reported or awarded.
Uploading the right file shows "This will replace the existing BOQ (N lines)"; confirming with
"Replace existing BOQ" swaps it in one transaction. If any line is in use, validate refuses and lists
what blocks it.

**Acceptance Scenarios**:

1. **Given** a BOQ with no references, **When** a new file is validated, **Then** the report says it is replaceable; confirm without `replaceExisting` is refused; confirm with it replaces.
2. **Given** one line is on a client bill, **When** a new file is validated, **Then** it is refused with `BOQ_REPLACE_BLOCKED` naming the billed line.

---

### User Story 6 - Delete an empty section; set the basis by hand (Priority: P3)

An empty section can be deleted; a section with lines cannot. A manually added line takes a basis
(default percentage) and the basis can be changed on an unbilled line. The BOQ view shows each line's
basis.

**Acceptance Scenarios**:

1. **Given** an empty group, **When** deleted, **Then** it is gone; **given** a group with lines, **Then** 409 `BOQ_GROUP_NOT_EMPTY`.
2. **Given** a manual line added as item-rate, **When** billed, **Then** no quoted percentage is applied.
3. **Given** a billed line, **When** its basis is changed, **Then** it is refused with `BOQ_PRICING_BASIS_LOCKED`.

### Edge Cases

- A single-schedule percentage workbook imports exactly as before (same numbers, same quoted %).
- An item-rate-only workbook sets no quoted percentage and asks no choice.
- A schedule sheet with a header but no lines among several schedules: reported, contributes nothing; the import is refused only if no schedule has a line.
- An estimate import never sets or asks about the project's quoted percentage.
- Two percentage schedules with different percentages → blocker.
- A replace racing a new bill: the in-transaction re-check refuses.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The import MUST read every schedule sheet in a workbook (any sheet with a recognisable header row), not only the first.
- **FR-002**: Each schedule MUST be classified as item-rate or percentage from its own label, defaulting to percentage.
- **FR-003**: Every BOQ line MUST carry a pricing basis (`percentage` or `item_rate`); existing lines default to percentage.
- **FR-004**: The project's quoted percentage MUST apply only to percentage-basis, non-non-BOQ lines in every computed quoted amount: client bill composition, bill views (quoted rate), bill package composition and claim edits, certification amounts, certified-copy pricing, the billable BOQ summary's quoted total, and the web screens that price lines (bill sheet, award editor, BOQ view, certified-copy review).
- **FR-005**: Tax, total and quoted-rate summary rows MUST NOT become BOQ lines or section headings; they MUST be listed in the report as excluded rows with their amount.
- **FR-006**: Each schedule MUST be reconciled separately; a difference beyond the tolerance (one paisa per line) MUST block confirm.
- **FR-007**: The report MUST show, per schedule: sheet name, basis, sections, lines, derived and stated totals, excluded tax amount, quoted percentage (percentage schedules), and whether it reconciles.
- **FR-008**: When the workbook's quoted percentage differs from the project's, the report MUST show both and confirm MUST require an explicit `file` or `project` choice.
- **FR-009**: Importing over an existing BOQ MUST be allowed when no line of that variant is measured, in a DWR, billed or awarded, MUST require an explicit replace flag on confirm, and MUST remove the old sections and lines in the same transaction.
- **FR-010**: When replacement is blocked, the refusal MUST list what blocks it (counts per kind and the affected line numbers).
- **FR-011**: An empty BOQ section MUST be deletable; a non-empty one MUST be refused.
- **FR-012**: Manual line create MUST accept a basis; line edit MUST accept a basis change unless the line is billed.
- **FR-013**: Line numbers in a multi-schedule workbook MUST be prefixed with the sheet name.
- **FR-014**: Confirm MUST be audited with the schedules, the quoted-percentage decision and whether it replaced an existing BOQ.

### Key Entities

- **BOQ line pricing basis**: `percentage` (priced at schedule rate × (1 + project quoted %)) or `item_rate` (priced at its own rate).
- **Schedule (import-time only)**: one sheet's block — basis, groups, lines, totals, excluded rows.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All three mixed fixture workbooks import 100% of both schedules' lines, and each schedule's derived total matches the file's stated total within tolerance.
- **SC-002**: Zero tax/total rows are imported as lines across the fixture set.
- **SC-003**: A bill on an item-rate line differs from quantity × rate by ₹0.
- **SC-004**: No confirm can change a project's quoted percentage without an explicit choice when the two differ.
- **SC-005**: A wrongly imported, untouched BOQ can be replaced in one upload-and-confirm.

## Assumptions

- The template is BoQ_Ver3.0 or a workbook with the same header vocabulary; other layouts keep 008's single-schedule behaviour through the same header detection.
- The in-memory batch store (single API instance) is unchanged.
- Bills already raised keep their frozen amounts; only line views re-derive the quoted rate, and the basis of a billed line cannot change.
