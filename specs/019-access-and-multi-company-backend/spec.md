# Feature Specification: Access Granularity and Multi-Company

**Feature Branch**: `019-access-and-multi-company`

**Created**: 2026-09-13

**Status**: Draft

**Input**: Client requirements spreadsheet, Notes 17, 22 and 24.

**Surfaces**: buildcore-api (permission model, cash visibility enforcement, company scoping) and
buildcore-web (company switcher, permission-aware navigation and screens).

## What exists and what is inexpressible

Permissions today are module-shaped: `MACHINERY`, `LOGBOOK`, `FUEL`, `INVENTORY`, `PAYROLL` and so
on, with a handful of separate approval values (`INVENTORY_APPROVE`, `LABOUR_APPROVE`,
`RECRUITMENT_APPROVE`, `ASSETS_APPROVE`). Holding one means being able to both see and change
everything in it. The client's example in Note 22 cannot be expressed at all: *a site operator who
may enter logbook readings and diesel, but may not see the rest of the machinery register and may
not edit anything else.* There is no read-versus-write distinction anywhere in the model.

Multi-company is already real in the data — every record is company-scoped, RLS enforces it, and
`CROSS_COMPANY_ACCESS` exists for users who span both — but **the web application has no way to
switch between companies**, so the client's two companies cannot both be worked in.

## Clarifications

### Session 2026-10-02

The two cash questions, open since this specification was written and the last thing holding item 16.

- Q: With cash hidden, may cash still be entered? → A: **Hide the figures, and block entry — but as
  two controls, not one.** The client's answer to the first question was "hide and block"; the answer
  to the follow-up was that blocking cannot ride on the company-wide setting. So display stays
  governed by `hideCashTransactions`, and entry is governed by a new `CASH_ENTRY` permission.
- Q: Why not one setting doing both? → A: **Because the setting is company-wide.** A setting that
  blocked entry would stop every cashier in the company from paying labour while it was on. In
  practice that makes it a switch somebody flips before a visitor arrives and flips back after, which
  protects nothing. Two controls let a cashier keep working while an office viewer sees neither the
  figure nor the controls.
- Q: Which screens count as cash? → A: **Vendor and supplier payments, and labour cash payouts** —
  and not salaries, payslips or employee advances.

  **This answer cannot be implemented as given, and the fault is in how it was asked.** Both cash
  markers in *this* specification were already resolved during the web half's planning, against
  shipped code, and this specification was never updated — so the question was put to the client as
  open when it was not. The shipped product holds **no screen list at all**: a figure is hidden when
  its own row's `paymentMode` names a cash mode, plus `denominationBreakup`, which is hidden
  unconditionally. A screen-level rule is a different mechanism, not a longer list.

  Consequences of the mismatch, each needing a decision rather than an assumption: a salary **paid in
  cash** is hidden today, which the answer says it should not be; a vendor payment **paid by bank
  transfer** is not hidden, which the answer says it should be; and the denomination breakup is hidden
  from everyone including the cashier who counts notes against it.

  **Resolved in a second round the same day.** The per-row rule stays and acquires no screen list
  (FR-017c); the cash-paid salary divergence is accepted knowingly; and the denomination breakup
  becomes visible to `CASH_ENTRY` holders only (FR-017d). So of the three cash answers, exactly one
  changes hiding — the breakup — and the rest of the work is the entry permission.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A site operator can enter readings and nothing else (Priority: P1)

An operator at site opens Plant and Machinery and can record logbook entries and diesel readings for
the machines at their site. They cannot see purchase values, hire rates or the wider machinery
register, and they cannot edit anything they did not enter. Their role is defined once and applies
everywhere.

**Why this priority**: Note 22 is the only note in this feature describing something the system
cannot express at all. Until permissions separate reading from writing, every role is an
over-permission, and the client has told us they are handing accounts to site staff.

**Independent Test**: Define a role with write access to logbook and fuel only, sign in as it, and
confirm both the allowed entry and every refused path behave as specified.

**Acceptance Scenarios**:

1. **Given** a role with write access to logbook only, **When** the holder opens Plant and Machinery,
   **Then** logbook entry is available and the machinery register, hire rates and bills are not shown.
2. **Given** that role, **When** the holder requests a machinery record directly by address, **Then**
   it is refused.
3. **Given** a role with read access but not write to a module, **When** the holder opens it, **Then**
   records are visible and every create, edit and delete control is absent.
4. **Given** a role with read access but not write, **When** a write is attempted directly against
   the interface, **Then** it is refused and recorded.
5. **Given** an existing role defined before this feature, **When** it is used after, **Then** its
   holders retain exactly the access they had, with no silent widening or narrowing.

---

### User Story 2 - Working in either company, and knowing which (Priority: P1)

A user who works across both companies chooses which one they are working in from the top of the
screen. Everything they then see and create belongs to that company. The current company is visible
at all times, because entering a purchase against the wrong company is expensive and quiet.

**Why this priority**: Note 24. The client operates two companies — Tirupati Enterprises and Parth
Realcon Pvt Ltd — and has told us they need both in the portal. The data layer is ready; the
application simply offers no way to reach it.

**Independent Test**: As a user with cross-company access, switch companies and confirm every list,
creation and report reflects the selection, and that the selection survives a reload.

**Acceptance Scenarios**:

1. **Given** a user with access to both companies, **When** they sign in, **Then** the current company
   is shown and can be changed from a control at the top of every screen.
2. **Given** a company is selected, **When** any list is opened, **Then** only that company's records
   appear.
3. **Given** a company is selected, **When** a record is created, **Then** it belongs to that company
   without the user restating it.
4. **Given** a user with access to one company only, **When** they sign in, **Then** their company is
   shown and no switcher is offered.
5. **Given** a company is selected, **When** the page is reloaded or the browser reopened, **Then**
   the same company is still selected.
6. **Given** a user switches company, **When** the switch completes, **Then** no data from the
   previous company remains on screen or in any cached view.

---

### User Story 3 - Hiding cash when cash should not be on screen (Priority: P2)

An authorised user turns on a setting that hides cash amounts and cash transactions across the
portal. Screens that would show them show the rest of their content without them. Turning it off
restores the view.

**Why this priority**: Note 17, and the client is explicit that it is occasional and deliberate
(*"if we required to hide all cash transaction and entry for sometime"*). P2 because it is a
visibility control over data the system already holds, and it depends on nothing else here.

**Independent Test**: Turn the setting on and confirm every screen carrying cash figures hides them
and remains usable; turn it off and confirm they return.

**Acceptance Scenarios**:

1. **Given** cash hiding is on, **When** a screen containing cash amounts is opened, **Then** those
   amounts are not displayed and the remaining content is unaffected.
2. **Given** cash hiding is on, **When** a report or export containing cash figures is produced,
   **Then** it excludes them consistently with the screen.
3. **Given** cash hiding is on, **When** a cash entry is attempted, **Then** the behaviour is as
   specified by the clarification below.
4. **Given** cash hiding is toggled, **When** the change is made, **Then** who changed it and when is
   recorded.
5. **Given** cash hiding is on, **When** a user without authority attempts to turn it off, **Then**
   it is refused.

### Edge Cases

- A role is edited to remove write access while a holder has an unsaved form open.
- A user's cross-company access is revoked while they have the other company selected.
- A record is opened by direct link that belongs to a company other than the selected one.
- Cash hiding is on and a labour payment sheet — which is inherently cash — is opened. Hiding the
  amounts may make the screen meaningless; this needs the clarification below.
- A role holds write but not read on a module. The specification must say whether this is coherent
  or refused at definition time.
- Existing roles carry module permissions that must map onto the new read/write model without
  changing anyone's effective access on the day of migration.
- Two companies have a user with the same email.
- Reports that aggregate across companies for a cross-company user.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST distinguish read access from write access for each module.
- **FR-002**: System MUST allow a role to hold write access to a specific area within a module
  without granting access to the rest of that module.
- **FR-003**: System MUST refuse a write from a role holding only read access, and MUST record the
  refusal.
- **FR-004**: System MUST hide, not merely disable, controls for actions the current role cannot
  perform.
- **FR-005**: System MUST refuse direct access to records outside the role's granted areas, not only
  hide their navigation.
- **FR-006**: System MUST preserve the effective access of every existing role through the migration
  to read/write granularity, with no silent widening or narrowing.
- **FR-007**: System MUST allow an administrator to define these finer roles without a code change.
- **FR-008**: Users with access to more than one company MUST be able to select the company they are
  working in, from a control present on every screen.
- **FR-009**: System MUST display the currently selected company at all times.
- **FR-010**: System MUST scope every list, report and creation to the selected company.
- **FR-011**: System MUST persist the selected company across page reloads and browser restarts.
- **FR-012**: System MUST clear data belonging to the previous company from view on switching.
- **FR-013**: System MUST NOT offer a switcher to users with access to a single company.
- **FR-014**: System MUST provide a setting that hides cash amounts and cash transactions across the
  application.
- **FR-015**: System MUST apply cash hiding consistently to screens, reports and exports.
- **FR-016**: System MUST restrict who can change the cash hiding setting, and MUST record every
  change with actor and time.
- **FR-017**: System MUST NOT delete or alter cash data when hiding is on; hiding is a display
  control, not a data operation.
- **FR-017a**: System MUST treat hiding and entry as **two separate controls**. `hideCashTransactions`
  stays company-wide and governs display only. Whether a caller may still *enter* cash is governed by
  a permission, not by the setting. One control cannot do both: the setting is company-wide, so a
  setting that blocked entry would stop every site cashier in the company from paying labour for as
  long as it was on — which makes it a switch nobody can leave on, and therefore no protection.
- **FR-017b**: System MUST gate cash entry on a `CASH_ENTRY` permission, so a site cashier keeps
  working while an office viewer sees neither the figures nor the controls that produce them.
- **FR-017c**: System MUST continue to decide hiding **per row, from that row's own payment mode**, and
  MUST NOT acquire a screen list. Confirmed on 2026-10-02 after the mismatch above was put to the
  client: a figure is hidden where the money actually moved in cash, wherever that figure appears. A
  screen list was offered and declined — it is a second rule over the same setting, and the half that
  goes stale when somebody adds a screen.

  Consequence the client accepted explicitly: **a salary genuinely paid in cash stays hidden**, and a
  vendor payment made by bank transfer stays visible. Their screen answer was "hide vendor and labour
  payouts, not salaries", and the per-row rule delivers that in every case except a cash-paid salary.
- **FR-017d**: System MUST show the labour payment sheet's note-denomination breakup to a caller
  holding `CASH_ENTRY`, and MUST hide it from everyone else. It is hidden from everyone today, the
  cashier counting notes against it included — which conceals nothing from anybody it was meant to
  conceal from while making the screen's purpose unreachable. This is the one change hiding needs.

### Non-Functional Requirements

- **NFR-001** *(Note 25)*: The company switcher MUST be reachable and operable on Android and iOS
  phones at 320px width without obscuring page content. **Not verified today.**
- **NFR-002**: A permission decision MUST not add more than 50ms at the 95th percentile to a request.
  **Not verified today**; the current module-level check has not been measured, so this is a target
  to hold the finer model against, not a regression threshold.

### Key Entities

- **Permission**: An access right, distinguishing the area it covers from the level (read or write)
  it grants.
- **Role**: A named set of permissions, company-scoped, definable by an administrator.
- **Company Selection**: The company a user is currently working in — per user, persisted, and
  constrained to the companies they may access.
- **Cash Visibility Setting**: A company-level display control with an owner and a change history.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The client's Note 22 example — logbook and diesel entry only, no visibility of the rest
  of machinery — is definable as a role and behaves correctly on all paths, including direct access.
- **SC-002**: Every existing role's effective access is identical before and after migration,
  demonstrated by an access matrix compared across the change.
- **SC-003**: A user with cross-company access can work in either company, and 100% of records they
  create belong to the selected one.
- **SC-004**: Company selection survives browser restart, verified in Chrome and Safari.
- **SC-005**: With cash hiding on, no cash amount appears on any screen, report or export — verified
  across every module that holds one.
- **SC-006**: No write succeeds from a read-only role, across every module, verified by direct
  interface calls rather than through the interface alone.

## Assumptions

- Row-level security already enforces company isolation at the data layer; the switcher selects which
  company context is used and does not become the only thing standing between companies.
- The existing `CROSS_COMPANY_ACCESS` permission continues to mean "may access more than one
  company", and this feature gives it a usable interface rather than redefining it.
- Read/write granularity is expressed per module area rather than per endpoint. Per-endpoint
  permissions would be more precise and unmanageable for an administrator.
- Cash hiding applies to display and export. It does not restrict who may enter cash transactions,
  which is a permission question and is handled by FR-001 to FR-007.
- The two companies named in Note 24 (Tirupati Enterprises, Parth Realcon Pvt Ltd) are ordinary
  company records; nothing about this feature is specific to them.

### Needing the client's decision

*The cash questions were answered on 2026-10-02 — see Clarifications. They are now FR-017a to
FR-017d.*

- **[ASSUMED, NOT ASKED: how should existing roles map to read/write?]** Every current module
  permission became read+write, preserving today's behaviour exactly (FR-006), and that is what
  shipped. It was deliberately **not** put to the client on 2026-10-02: the alternative — tightening
  roles by default — would remove access somebody has today without anyone deciding which access, and
  there is no answer to that question that is safe to guess. The consequence of the default is stated
  plainly instead: **no role gets tighter until somebody deliberately tightens it**, and the role
  editor that makes tightening possible is the remaining work.
