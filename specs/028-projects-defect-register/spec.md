# Feature Specification: Projects defect register

**Feature Branch**: `004-dashboard-backend` (continuing; no branch of its own)

**Created**: 2026-10-06

**Status**: Draft

**Input**: Eighteen items reported by the client on 6 October 2026 after a run through Projects, each read against the code before being written down. The triage, with the evidence per item, is at `https://claude.ai/code/artifact/98f1dc3c-b075-4979-88ba-944bac624208`.

---

## Why this is numbered 028 and not 027

The next free directory under `specs/` is `027`. It is deliberately skipped. Twenty-five commits already in history carry the prefix `feat(027)` / `fix(027)` and belong to a body of ad-hoc work — the Subcontractors redesign, bill auto-numbering, BOQ ordering, the schedule split — that was done directly from user requests and never had a spec. Creating `specs/027-…` now would make every one of those commits appear to implement this document, which they do not. The gap is the record.

---

## What this feature is

A completion-and-repair pass. **Four of the twenty-two requirements are genuinely new mechanisms; the rest are wiring, removal, a control over machinery that already exists, or a constraint that was written wrong.** Each requirement below states what already exists, because the largest risk on a list like this is rebuilding something that works.

One item from the client's list is deliberately absent: see *Out of scope*.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A second subcontractor can be billed at all (Priority: P1)

A project engages two subcontractors. The first has been billed; the quantity surveyor now composes the first bill for the second and is shown database text: `[P2002]: Invalid 'prisma.rABill.create()' invocation:Unique constraint failed`. No bill can be raised for that subcontractor by any route.

**Why this priority**: It stops work outright, it is a regression introduced on 2026-10-05, and the person who meets it has no way to act on what the screen says.

**Independent test**: On a project with one work order already holding RA-01, compose a package for a second work order. A bill is created, numbered RA-01 on its own contract, and both bills coexist.

**Acceptance scenarios**:

1. **Given** work order A holds RA-01, **When** a package is composed for work order B, **Then** B's first bill is RA-01 and the composition succeeds.
2. **Given** work order A holds RA-01, **When** a second bill is composed for work order A, **Then** it is RA-02.
3. **Given** a genuine duplicate is attempted, **When** the database refuses it, **Then** the caller receives a 409 and a sentence naming the condition — never a Prisma message.

---

### User Story 2 - A deduction appears on the document the client receives (Priority: P1)

A quantity surveyor records a recovery against a bill, issues it, and the PDF the subcontractor receives does not mention it. The figure was saved; it was saved in the one of two places the document does not read.

**Why this priority**: The system produced a document that understates what was deducted. The money is wrong on paper, and nothing on screen says so.

**Independent test**: Record a deduction through the supported path, render the PDF, and read the figure in the rendered document — not in the database.

**Acceptance scenarios**:

1. **Given** a deduction entered on a package, **When** the bill PDF is rendered, **Then** the figure appears in the abstract.
2. **Given** a bill whose row carries legacy deduction values, **When** the migration has run, **Then** the same totals are still reported after the bill sheet stops accepting them.
3. **Given** the bill sheet, **When** a caller submits one of the three retired fields, **Then** it is refused rather than silently stored.

---

### User Story 3 - A client bill is proposed from the work that was actually done (Priority: P2)

A client bill is composed by typing quantities against a 231-line schedule, while the same application already holds approved daily work reports recording what the site did. The two are never compared.

**Why this priority**: It is the point of recording daily work. The capability exists and is reachable only from the other direction.

**Independent test**: Approve daily work against three BOQ lines, compose a client bill for that period, and find those three quantities proposed without anybody typing them.

**Acceptance scenarios**:

1. **Given** approved daily work in a period, **When** a client bill is composed for it, **Then** every line's quantity is proposed from the approved measurement.
2. **Given** a proposed quantity a surveyor disagrees with, **When** they override it, **Then** a reason is required and recorded.

---

### User Story 4 - An award is approved before it commits the company (Priority: P2)

A work order for several crore becomes active when one person saves it. The first bill raised under it then requires approval.

**Why this priority**: The control is inverted. It is the only item on the client's list that is a financial control gap rather than a missing feature.

**Independent test**: Raise a work order, confirm it cannot be billed against, approve it, confirm it can.

**Acceptance scenarios**:

1. **Given** a newly raised work order, **When** it is saved, **Then** it is pending approval and not active.
2. **Given** a work order pending approval, **When** a bill is composed against it, **Then** the composition is refused and names the reason.
3. **Given** approval is granted, **When** a bill is composed, **Then** it proceeds.

---

### User Story 5 - A purchase is recorded at the rate agreed with that vendor (Priority: P2)

A storekeeper records a purchase and types whatever rate they like. Stock is valued at a weighted average recomputed on every receipt, so a mistyped rate silently restates the value of every unit of that material already held.

**Why this priority**: It is a control the client asked for, and the consequence reaches further than the purchase row — into the stock ledger.

**Independent test**: Buy an item from a vendor for the first time, type a rate; buy it again from the same vendor and find the rate filled in and unalterable; change it only through an approval.

**Acceptance scenarios**:

1. **Given** a vendor–item pair never purchased, **When** a purchase is recorded, **Then** the rate is accepted and becomes the agreed rate.
2. **Given** an agreed rate exists, **When** a purchase is recorded for that pair, **Then** the rate is supplied and cannot be altered by any caller, including directly against the update endpoint.
3. **Given** an agreed rate exists, **When** a change is requested and approved, **Then** purchases from that point use the new rate and purchases already made are unchanged.
4. **Given** an item agreed with other vendors, **When** a first purchase is recorded from a new vendor, **Then** those other agreed rates are visible while the rate is typed.

---

### User Story 6 - A subcontractor's bill can be found, signed for, and paid (Priority: P3)

A bill reaches *certified* and the trail ends. Nothing records that the signed copy came back or that money left.

**Why this priority**: Real, but the business runs today by tracking these elsewhere. It is the largest of the remaining items and the least urgent of them.

**Independent test**: Certify a bill, upload the signed copy, record a part payment, and read the outstanding figure for that subcontractor.

**Acceptance scenarios**:

1. **Given** a certified bill, **When** the signed copy is uploaded, **Then** the bill reports as acknowledged.
2. **Given** a certified bill of ₹100, **When** ₹60 is recorded as paid, **Then** ₹40 is reported outstanding.
3. **Given** several bills for one subcontractor, **When** the outstanding view is opened, **Then** it reports across bills rather than per bill.

---

### User Story 7 - A day's work can be filed, read and sent on (Priority: P3)

A daily report cannot be downloaded, carries a weather field nobody uses, and does not say who filed it.

**Independent test**: Submit a report, download it as a workbook that matches the client's own form, and read the names of the person who recorded it and the person who submitted it.

**Acceptance scenarios**:

1. **Given** a submitted report, **When** it is downloaded, **Then** the workbook matches the agreed layout.
2. **Given** a report returned for correction and resubmitted by someone else, **When** it is read, **Then** both names are reported separately.

---

### User Story 8 - The screens stop hiding what they already hold (Priority: P3)

The bill composer offers every work order on the project; changing company strands the user on a dead page; the project overview shows thirteen facts out of more than twenty it has in hand.

**Independent test**: Each of the three, performed on a project that exercises it.

**Acceptance scenarios**:

1. **Given** a project with several subcontractors, **When** a bill is composed, **Then** the subcontractor is chosen first and only their work orders are offered.
2. **Given** a chosen work order, **When** the subcontractor is changed, **Then** the work order selection is cleared.
3. **Given** a project open on screen, **When** the selected company changes, **Then** the user arrives at that company's portfolio with an explanation rather than on an error.

---

### Edge Cases

- A bill with no work order at all — uniqueness cannot be expressed on a nullable column in Postgres, because NULLs do not collide. FR-002 decides what the rule is rather than leaving it to the migration.
- A work order with no subcontractor recorded, and one raised before work orders were numbered: both exist in live data today, and a picker that filters them out makes them unbillable with nothing on screen to explain why.
- An item agreed with one vendor and bought from another: by design this is a first purchase, typed freely. See FR-015.
- A purchase recorded before any of this existed: FR-014 keeps it editable rather than refusing every edit against a contract that did not exist when it was made.
- A report whose author and submitter are the same person — both are still reported, because the pair is what makes the distinction visible when they differ.

---

## Requirements *(mandatory)*

Each requirement states **what already exists**, so that nothing here is rebuilt.

### Group A — a bill cannot be composed

- **FR-001**: Bill numbers for a subcontractor MUST be unique within the work order they belong to, not within the project. *Exists*: the allocator already counts per work order; only the constraint disagrees, and it is the disagreement that refuses the bill.
- **FR-002**: The system MUST state and enforce what uniqueness means for a bill carrying no work order. A nullable column cannot carry the rule by itself.
- **FR-003**: A duplicate bill number MUST be reported to the caller as a refusal in a sentence, never as database text. *Exists*: two of the three composition paths already do this; the package path does not.

### Group B — one place to record a deduction

- **FR-004**: A deduction MUST be recorded in exactly one place, and that place MUST be the one the issued document reads. *Exists*: the abstract and the rendered PDF already read the package's ten adjustment columns correctly and need no change.
- **FR-005**: Values already held in the retired fields MUST be carried over, so that no figure visible on a screen today disappears when those fields stop being read.
- **FR-006**: The retired fields MUST refuse input rather than accept it into a column nothing prints.
- **FR-007**: A client bill MUST be composable from approved daily work for the period. *Exists*: the proposal mechanism already does this for both bill directions.
- **FR-008**: A quantity that overrides a proposed one MUST carry a reason.

### Group C — approvals, where none exist

- **FR-009**: A work order MUST be approved before it is active, and MUST NOT be billable until it is. *Exists*: the approval machinery, used today for running-account bills; a work order has never been submitted to it.
- **FR-010**: A change to an agreed purchase rate MUST require approval. *Exists*: nothing — there is no approval chain anywhere in the inventory module, which is why FR-009 and FR-010 are one piece of work.

### Group D — the vendor rate contract

- **FR-011**: An agreed rate MUST be held per vendor and item, with the period it applies to. *Exists*: an equipment hire rate already has exactly this shape, including the convention that an open end means "current".
- **FR-012**: The first purchase of a vendor–item pair MUST accept a typed rate and record it as agreed. A known item from a new vendor is a first purchase.
- **FR-013**: Once agreed, the rate MUST be supplied on a purchase and MUST NOT be alterable — including by a caller addressing the update endpoint directly, which accepts a rate from anybody today. A locked field over an open endpoint is a control in appearance only.
- **FR-014**: The rule MUST apply forward only. Purchases already recorded stay editable.
- **FR-015**: An approved rate change MUST apply from approval onward and MUST NOT restate purchases already made — those were what the vendor actually billed.
- **FR-016**: When an item is agreed with other vendors, those rates MUST be visible while a first rate is typed, and first-purchase rates MUST be reportable for a period. **This is a chosen limit, not an oversight**: a rate locked per vendor can be stepped around by adding a vendor, blocking new suppliers would be worse, and so the control is visibility rather than refusal.
- **FR-017**: A purchase MUST carry a bill and a photograph before it is approved — not before it is recorded, because a site photographing a delivery at dusk with no signal must still be able to record it. *Exists*: a bill file, optional; no photograph at all. Not retrospective.

### Group E — documents and money that leaves

- **FR-018**: A debit note MUST be producible as a document in its own right. *Exists*: the debit register already prints inside the bill package; the standalone document a subcontractor signs does not exist.
- **FR-019**: A debit note MUST carry a number allocated when it is raised, so that the document and the register cannot disagree about which debit it is.
- **FR-020**: A signed copy returning MUST be recordable against a running-account bill and against a debit note, and MUST change the document's state rather than only adding a file. A file in a list cannot answer "which bills are unacknowledged".
- **FR-021**: Payments MUST be recordable against a bill, in parts, and the outstanding amount MUST be derived from what has been certified and what has been paid rather than stored. Outstanding MUST be readable across a subcontractor's bills, not only per bill.

### Group F — daily work

- **FR-022**: A submitted report MUST be downloadable as a workbook matching the client's own form. *Exists*: no export of any kind.
- **FR-023**: Weather MUST be removed from report entry, and the recorded history MUST be retained. Removing the input is the request; discarding what was recorded is not, and costs nothing to avoid.
- **FR-024**: A report MUST report who recorded it and who submitted it, by name. *Exists*: both identities are already stored and already returned as identifiers; only the names are missing.

### Group G — screens that already hold their data

- **FR-025**: A bill MUST be composed by choosing the subcontractor first and then one of their work orders. *Exists*: every work order already carries its subcontractor, and the names are already resolved elsewhere on the same screen.
- **FR-026**: Changing the subcontractor MUST clear the chosen work order. This is the one failure the control can introduce, and it would compose a bill against the wrong contract.
- **FR-027**: Work orders with no subcontractor recorded MUST remain reachable in the picker rather than being filtered out of existence.
- **FR-028**: Opening a project that belongs to another company after a company switch MUST return the user to the portfolio of the company now selected, with an explanation. The refusal itself is correct and MUST NOT change.
- **FR-029**: The project overview MUST show the commercial terms it already holds — the client's retention and the quoted percentage — distinct from descriptive facts.
- **FR-030**: Material issue MUST be named "Issue / Consumption material" in the interface. Labels only: the address stays, because renaming it breaks every link already sent for no gain.

### Key Entities

- **Agreed rate** — a vendor, an item, a rate, and the period it applies to. New.
- **Bill payment** — a bill, a date, an amount, an instrument and its reference. New.
- **Debit note number** — a company-wide sequence, allocated at the moment a debit is raised. New.
- **Signed copy** — a stored file against a bill or a debit note, and the state change its arrival causes. New.
- **Work order** — gains a state between drafted and active.
- **Running-account bill** — loses three deduction fields to the package that already owns them.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A project with any number of subcontractors can raise a first bill for each of them; the number each subcontractor sees starts at one for their own contract.
- **SC-002**: Every deduction recorded against a bill appears on the document the recipient receives. Verified by reading the rendered document, not the database.
- **SC-003**: A client bill for a period can be produced without anybody typing a quantity, where daily work for that period has been approved.
- **SC-004**: No work order can be billed against until it has been approved.
- **SC-005**: For any vendor–item pair purchased more than once, every purchase after the first carries the agreed rate, and no route exists to change it without an approval.
- **SC-006**: For any certified bill, the amount outstanding can be read without a person performing the subtraction.
- **SC-007**: A submitted daily report can be sent to a client as a document without being retyped.
- **SC-008**: No screen in Projects renders a figure that the response carrying it also contains but does not show — measured against the three named in FR-025, FR-028 and FR-029.

---

## Testing requirements

Every requirement's test MUST assert **what a user would see** — a value on the response, or a figure in the rendered document — and never that a function was called.

This is written as a requirement because the failure is recorded nine times in this repository: a sort placed in a method that returns nothing while the suite stayed green; an address asserted with `toContain` so a broken one passed; a response shape asserted by containment so a missing field passed. The precedent this feature follows is the quoted-percentage test shipped on 6 October, which asserts the **sign** and not the magnitude, because taking the absolute value would have passed against the very defect it was written for.

For each group, the assertion that must not be weakened:

| Group | The test | What would make it vacuous |
|---|---|---|
| A | Two work orders on one project each hold a bill numbered RA-01 | Asserting only that composition returned 201 — it did before, for the first work order |
| B | The figure read out of the **rendered** PDF | Asserting the column was written |
| C | A bill composed against an unapproved award is refused, **and** succeeds once approved | Only the refusal — a guard that refuses everything passes it |
| D | A second purchase's rate is unchanged after an attempt to alter it **through the update endpoint** | Asserting the form field is disabled |
| E | Outstanding reported as certified less paid, on a part payment | Asserting the payment row exists |
| F | The workbook's cells, read back | Asserting the download returned bytes |
| G | The work order selection after the subcontractor changes | Asserting the subcontractor control renders |

---

## Assumptions

1. Approval of a work order and of a rate change use the organisation's existing approvers, with no value threshold at first. Thresholds are a configuration question once the subject exists.
2. One daily-report layout serves every client until a second one asks otherwise.
3. The debit note number runs company-wide rather than per project, matching every other sequence in the system.
4. Partial payments are the normal case, not an exception.
5. An agreed rate does not vary by site. Freight to a remote site is commonly inside a rate, so this may return; it is recorded here as a decision rather than an omission.

---

## Out of scope

- **"Document is mandatory" when editing a project — reported, withdrawn, and to receive no code change.** The requirement is enforced at creation only, and the edit path neither asks for the required set nor sends anything against it, so the reported refusal cannot arise on the path that exists. It stopped reproducing. Changing code to fix something that is not happening is how a working path acquires a defect; if it returns, it returns with the address and the message that identify it.
- The project schedule and progress module, which remains the largest unbuilt thing in Projects and has its own specification already written.
- The nine pre-existing index-name drifts.
- Per-client layouts for the daily report.
- Any change to how the refusal after a company switch is produced. The server is right; only the screen is not.
