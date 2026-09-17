# Feature Specification: Documents and Letters

**Feature Branch**: `017-documents-and-letters`

**Created**: 2026-09-13

**Status**: Draft

**Input**: Client requirements spreadsheet, Notes 1, 3, 19, 20, 21 and 26.

**Surfaces**: buildcore-api (company documents, project document requirements, letter kinds,
signature and signed-copy storage, payment proof) and buildcore-web (upload and issue screens,
letter menus in Recruitment and Project Details).

## What exists and what does not

The company record already stores the *numbers* — GSTIN, PAN, CIN, TAN, PF establishment code, ESIC
code, professional tax registration, BOCW registration. **There is no company document store at all**,
so not one of the certificates behind those numbers can be attached. Project documents can be
attached but nothing says which are required. Letters exist as a mechanism — templates and generated
letters, versioned and supersedable — but only for five kinds, all of them HR: offer, appointment,
confirmation, relieving, experience. The ten commercial kinds the client lists cannot be expressed,
and no letter can be signed.

## Clarifications

### Session 2026-09-15

- Q: Is "Digital Signature" (Note 19) a signature image applied to the rendered document, or a legally recognised Digital Signature Certificate under the IT Act? → A: A signature **image**. An authorised signature graphic is uploaded per signatory and stamped onto the rendered document at issue. No cryptographic signing, and the product makes no claim of legal non-repudiation.
- Q: Must issuing a work order, LOI or purchase order always go through the feature-016 approval chain, or only above a value threshold? → A: **Always.** Every commercial letter kind passes the director-final chain before it may be issued. No monetary threshold, and letters carry no committed-value field.
- Q: Should Aadhaar remain in the required company document set given it is regulated personal data? → A: **Keep it**, with the controls previously written as assumptions promoted to testable requirements: permission-restricted access, every retrieval audit-logged, and never rendered into any letter.

### Session 2026-09-16

Raised during manual verification of the shipped feature. All three are gaps in what was built
against what this specification says, not new scope invented afterwards.

- Q: May an administrator file a company document of a kind outside the required eight — a MSME certificate, a trade licence, a rent agreement? → A: **Yes.** The required eight are the set *completeness is measured against*, never the set that may be *stored*. Any document kind the company has defined may be filed, and the ones outside the required eight are supplementary — present in the list, absent from the completeness count. FR-001 already said "classified by kind" without restricting which; the shipped list filtered to the required codes, so a supplementary document could be uploaded and then never seen again.
- Q: When a required kind has no document type defined for the company at all, what should the interface offer? → A: **Define the type in place.** The distinction between "defined but not uploaded" and "never defined" is already carried through the contract as a null type identifier, and the existing answer to the second case is an interface that offers nothing at all. An administrator looking at a kind reported missing must be able to act on it where they are standing.
- Q: An administrator wants to file a kind this product never declared — an MSME certificate, a trade licence, a rent agreement. Where do they define it? → A: **On the documents screen, as a company-scoped kind.** `DocumentType` serves two unrelated lists through one table — the employee file and the organisation's paperwork — and they were already mixed, so every company's Employee Setup list showed GST and work order among the marksheets. The kinds now carry a scope, the two screens show only what belongs to them, and each may create only into its own list. That is what allows creation from a `COMPANY_SETTINGS` screen without it becoming a second door to the `EMPLOYEES` permission guarding the employee master.
- Q: The project document requirements screen is read-only, so the set FR-007 describes cannot actually be changed by anyone. What is missing? → A: **The list of kinds available to require.** The write endpoint has existed since the feature shipped; what the interface never had was a way to name a document kind without knowing its identifier, which made an editor unbuildable. `DocumentType.scope` (FR-001b) supplies exactly that list, so the requirement surface now reports the kinds that may be required alongside the ones that are. The editor may also define a new kind, because requiring a paper this product never declared is otherwise a trip to another screen and back.
- Q: A company that has configured nothing runs on the six kinds this product ships. What should an editor do with that? → A: **Open on them, and say they are defaults until saved.** The first save adopts them as the company's own set. Starting empty would throw away a reasonable answer every company would rebuild by hand, and hiding the defaults behind a separate "start configuring" step would make the screen explain a state instead of showing it.
- Q: The company documents and signatory surfaces are pinned to the caller's own company while the rest of this feature accepts a named company. Fix here, or wait for feature 019's multi-company work? → A: **Fix here, narrowly.** These two surfaces are made consistent with the two this same feature already shipped (letter kinds, project document requirements), reusing the company selector the plant and recruitment sections already mount. Feature 019 FR-008–FR-013 owns the *product* answer — one switcher at the top of every screen, persisted across reloads, hidden for single-company users — and replaces that selector everywhere when it lands. This clarification does not move that scope into 017; it removes an inconsistency inside 017.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The company's statutory papers live in the system (Priority: P1)

An administrator uploads the company's GST certificate, PF and ESIC registrations, labour licence,
PAN and TAN cards, the proprietor's Aadhaar, and a cancelled cheque. Each is filed against its kind,
carries the reference number already held on the company record, and where it expires, the expiry is
recorded so it can be reminded on. Anyone who needs to send a certificate to a client or an inspector
finds it here rather than in somebody's email.

**Why this priority**: Note 1 is first in the client's list, and it is the only note in this feature
where nothing whatsoever exists today. A construction company that cannot produce its labour licence
on demand has a compliance problem, not an inconvenience.

**Independent Test**: Upload one document of each required kind, confirm each is retrievable, and
confirm the set is reported as complete only when all required kinds are present.

**Acceptance Scenarios**:

1. **Given** a company with no documents, **When** its KYC status is viewed, **Then** every required
   kind is listed as missing.
2. **Given** a GST certificate is uploaded against its kind, **When** the company is viewed, **Then**
   the document is retrievable and shown alongside the GSTIN already recorded.
3. **Given** a document kind that expires, **When** it is uploaded without an expiry date, **Then**
   the upload is refused and the expiry is requested.
4. **Given** a document approaching expiry, **When** the reminder sweep runs, **Then** a reminder is
   raised against the company.
5. **Given** a superseded document (a renewed licence), **When** the new one is uploaded, **Then** the
   previous version is retained and marked superseded rather than destroyed.
6. **Given** a user without company-settings permission, **When** they request a company document,
   **Then** it is refused.
7. **Given** a document kind the company has defined that is not one of the required eight, **When** a
   document is filed against it, **Then** it appears in the company's documents and does not change
   the completeness count either way.
8. **Given** a required kind for which the company has no document type at all, **When** the
   administrator acts on it from the documents screen, **Then** the type can be defined there and the
   kind becomes uploadable without leaving the screen.
9. **Given** a user who works across more than one company, **When** they choose a company on the
   documents screen, **Then** the documents, the completeness count and every upload belong to the
   chosen company.

---

### User Story 2 - A new project cannot start half-documented (Priority: P1)

When a project is created, the system knows which documents it needs — LOI, work order, insurance,
mining permission, labour insurance, BOQ — and says which are still missing. A project can be created
before they all arrive, because in practice they do not arrive together, but its readiness is visible
and its gaps are nameable.

**Why this priority**: Note 3. Missing project paperwork surfaces months later as an unbillable
claim or an uninsured site.

**Independent Test**: Create a project, confirm the required set is listed as outstanding, upload
some, and confirm the outstanding list shrinks accordingly.

**Acceptance Scenarios**:

1. **Given** a newly created project, **When** its documents are viewed, **Then** the six required
   kinds are listed with their status.
2. **Given** a project missing required documents, **When** it is viewed in the portfolio, **Then**
   its document readiness is visible without opening it.
3. **Given** a document uploaded against a required kind, **When** the project is viewed, **Then**
   that kind is no longer outstanding.
4. **Given** a project where every required document is present, **When** readiness is evaluated,
   **Then** it reports complete.
5. **Given** a document kind not in the required set, **When** it is uploaded, **Then** it is accepted
   and filed as supplementary.

---

### User Story 3 - Thirteen kinds of letter, drafted once, issued many times (Priority: P1)

The company fixes the wording and terms of each kind of letter once. Afterwards, issuing one means
choosing the recipient and filling the few details that vary; the system produces the letter. The
kinds cover HR (offer, appointment, relieving, transfer, suspension, salary slip) and commercial
(work order, LOI for subcontractors, purchase order, indent, service order, service bill, maintenance
bill).

**Why this priority**: Note 19 is the longest note in the sheet and names thirteen documents. Eight
of the ten missing kinds are commercial — the ones that commit the company to spend.

**Independent Test**: Define a template for a kind that does not exist today (a work order), issue one
against a real vendor, and confirm the output carries the fixed terms and the supplied details.

**Acceptance Scenarios**:

1. **Given** a template exists for a letter kind, **When** a letter of that kind is issued, **Then**
   the fixed terms appear unchanged and the variable details are filled from the named record.
2. **Given** a letter kind with no template, **When** issue is attempted, **Then** it is refused and
   the missing template is named.
3. **Given** a template is edited after letters were issued from it, **When** an old letter is
   retrieved, **Then** it renders as it was issued, not as the template now reads.
4. **Given** a letter is issued, **When** it is issued again for the same recipient, **Then** the
   earlier one is marked superseded and both remain retrievable.
5. **Given** a commercial letter (work order, PO), **When** it is issued, **Then** it is linked to the
   vendor or project it commits, and appears against that record.

---

### User Story 4 - A letter can be signed, and the signed copy comes back (Priority: P2)

A letter carries the authorised signature when issued, so it can be sent without being printed and
scanned. When the second party returns their countersigned copy, that copy is attached to the same
letter, so the executed document and the issued one sit together.

**Why this priority**: Note 19's last clause. P2 because letters are useful before they are signed,
and because signature handling needs decisions (below) that generation does not.

**Independent Test**: Issue a letter with a signature applied, download it, upload a countersigned
copy, and confirm both are retrievable against the same letter.

**Acceptance Scenarios**:

1. **Given** a letter kind configured to carry a signature, **When** it is issued, **Then** the
   signature appears in the produced document.
2. **Given** an issued letter, **When** a signed copy is uploaded, **Then** it is stored against that
   letter and both versions are distinguishable.
3. **Given** a letter awaiting a countersigned copy, **When** the letter is viewed, **Then** its
   execution status is visible.
4. **Given** a user without authority to issue a signed letter, **When** they attempt it, **Then** it
   is refused.

---

### User Story 5 - New kinds of letter without a developer (Priority: P2)

An administrator creates a template for a kind of letter nobody anticipated, and issues it, without
a code change.

**Why this priority**: Note 20. The current design bounds letters to a fixed list of five kinds, so
every new kind is a schema change. This story is what makes Note 19 affordable rather than a
thirteen-item backlog.

**Independent Test**: Create a letter kind that appears nowhere in this specification, define its
template, issue one.

**Acceptance Scenarios**:

1. **Given** the template screen, **When** an administrator defines a new kind with its fields and
   fixed terms, **Then** it becomes available for issue.
2. **Given** a custom kind in use, **When** an attempt is made to delete it, **Then** the deletion is
   refused while issued letters reference it.
3. **Given** a custom kind, **When** a letter is issued from it, **Then** it behaves exactly as a
   built-in kind for versioning, signature and retrieval.

---

### User Story 6 - Letters where the work is (Priority: P3)

Recruitment letters are reachable from Recruitment, and project and vendor letters from the project's
own screens, rather than everything living in one HR list.

**Why this priority**: Note 21. Placement, not capability — it depends on US3 and US5 existing first.

**Acceptance Scenarios**:

1. **Given** a project, **When** its detail screen is opened, **Then** a letters menu lists the
   letters issued for that project and offers the kinds relevant to it.
2. **Given** a candidate, **When** their record is opened, **Then** the recruitment letters for them
   are listed there.
3. **Given** a letter issued from a project, **When** it is viewed from the central letter list,
   **Then** it is the same letter, not a copy.

---

### User Story 7 - Proof that the money moved (Priority: P2)

When a payment is recorded, the RTGS advice or transaction confirmation is attached to it, so the
proof and the entry are one record.

**Why this priority**: Note 26. Small, self-contained, and it closes a real audit gap — payments
currently carry a reference number and nothing behind it.

**Acceptance Scenarios**:

1. **Given** a recorded payment, **When** a transaction proof is attached, **Then** it is retrievable
   against that payment.
2. **Given** a payment without proof, **When** payments are listed, **Then** its missing proof is
   visible.
3. **Given** a payment proof, **When** the payment is viewed by a user permitted to see it, **Then**
   the proof opens without leaving the payment.

### Edge Cases

- A required document kind is uploaded with the wrong file type (a photo of a certificate rather
  than a PDF). The specification must say what is accepted.
- A document is uploaded whose reference number contradicts the number held on the company record.
- A project is created for a client who supplies no LOI, only a verbal instruction.
- A letter template is edited between an approval and an issue.
- A signed copy is uploaded that does not correspond to the issued letter. The system cannot verify
  this; the requirement is that both are retained so a human can.
- Two administrators define custom letter kinds with the same name.
- A payment proof is attached to a payment that is later reversed.
- Storage of Aadhaar. This is personally identifiable and regulated; see Assumptions.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST store documents against a company, each classified by kind.
- **FR-001a**: System MUST accept and list a company document of **any** document kind the company has
  defined, not only the required ones (Clarifications, 2026-09-16). Kinds outside the required set are
  supplementary: they appear in the company's documents and are excluded from the completeness count.
  Stated explicitly because FR-001 and FR-003 are separable and were implemented as one — the shipped
  list was filtered to the required codes, so a supplementary document could be stored and was then
  invisible, which is worse than refusing it.
- **FR-001b**: Users MUST be able to define a company document kind the product never declared, from
  the documents surface, without holding the permission that guards the employee document master
  (Clarifications, 2026-09-16). Document kinds MUST carry a scope distinguishing the employee file
  from the organisation's paperwork, each surface MUST list only the kinds belonging to it, and a
  kind created from one surface MUST NOT appear on the other. A kind serving both — Aadhaar and PAN
  are required of the company and held on an employee's file — MUST be expressible as such rather
  than forced to one side.
- **FR-002**: System MUST define a required set of company document kinds covering at least GST, PF,
  ESIC, labour licence, PAN, TAN, Aadhaar and cancelled cheque.
- **FR-003**: System MUST report which required company document kinds are present and which are
  missing.
- **FR-003a**: Where a required kind has no document type defined for the company, System MUST allow
  that type to be defined from the documents surface itself (Clarifications, 2026-09-16). "Defined but
  not uploaded" and "never defined" are already distinguished in the contract; this makes the second
  case actionable rather than merely reported.
- **FR-004**: System MUST record an expiry date for document kinds that expire, and MUST refuse an
  upload of such a kind without one.
- **FR-005**: System MUST raise a reminder before a company document expires.
- **FR-006**: System MUST retain superseded documents rather than replacing them, **including the
  stored file itself and not merely the database row** — a retained record pointing at a deleted blob
  is not a retained document.
- **FR-006a**: For document kinds marked restricted (FR-024), superseded versions MUST be purged —
  row and stored file — once a configured retention period has elapsed, and the period MUST be
  configuration rather than a literal. FR-006's retain-indefinitely rule is right for a GST
  certificate and wrong for regulated personal data: keeping every superseded Aadhaar scan forever is
  a liability that grows on its own, and the general rule would otherwise mandate exactly that.
- **FR-007**: System MUST define a required set of project document kinds covering LOI, work order,
  insurance, mining permission, labour insurance and BOQ.
- **FR-007a**: The project document requirement surface MUST report which document kinds are
  *available to require* alongside which are required (Clarifications, 2026-09-16), scoped to the
  organisation's paperwork rather than the employee file (FR-001b). Without it the write endpoint
  FR-007 implies is unreachable from an interface: naming a requirement would mean knowing a
  document type's internal identifier, which nobody administering paperwork has or should need.
- **FR-008**: System MUST report project document readiness, and MUST make it visible in the project
  list without opening each project.
- **FR-009**: System MUST allow a project to be created before its required documents are complete.
- **FR-010**: System MUST support letter kinds covering at minimum: offer, appointment, confirmation,
  relieving, experience, transfer, suspension, salary slip, work order, LOI, purchase order, indent,
  service order, service bill and maintenance bill.
- **FR-011**: Users MUST be able to define a new letter kind and its template without a code change.
- **FR-011a**: A company-defined letter kind MUST NOT reuse the stable key of a kind this product
  ships. Two kinds answering to one key leave every lookup with two candidate rows and no stated
  precedence, and the ambiguity would surface first in the FR-010 migration backfill, where it is
  least recoverable.
- **FR-012**: System MUST render a letter from fixed terms plus variable details drawn from the named
  record.
- **FR-013**: System MUST render a previously issued letter as it was issued, regardless of later
  template edits.
- **FR-014**: System MUST supersede rather than overwrite when a letter is reissued, retaining both.
- **FR-015**: System MUST link commercial letters to the vendor, project or purchase they commit.
- **FR-015a**: System MUST refuse to issue a work order, LOI or purchase order until feature 016's
  approval chain for that action type is complete, by consuming `ApprovalService.assertMayTakeEffect`
  rather than implementing a second gate. This applies to **every** such letter regardless of value
  (Clarifications, 2026-09-15); the action types `letter_work_order`, `letter_loi` and
  `letter_purchase_order` are already declared and seeded with director-final chains by 016.
- **FR-016**: System MUST apply an authorised signature **image** to letter kinds configured to carry
  one, stamped onto the rendered document at issue. The signature is a stored graphic bound to a
  named signatory; it is **not** a cryptographic signature and the system MUST NOT present an issued
  letter as legally non-repudiable (Clarifications, 2026-09-15).
- **FR-016a**: System MUST record which signatory's image was applied to each issued letter, so a
  reissued or superseded letter still shows who signed the version that went out.
- **FR-017**: Users MUST be able to upload a countersigned copy against an issued letter, and both
  MUST remain distinguishable and retrievable.
- **FR-018**: System MUST show whether an issued letter has been executed (countersigned copy
  received).
- **FR-019**: System MUST surface letters relevant to a project from that project's own screens, and
  letters relevant to a candidate or employee from theirs.
- **FR-020**: Users MUST be able to attach a transaction proof to a recorded payment.
- **FR-021**: System MUST show which payments lack a transaction proof.
- **FR-022**: System MUST refuse deletion of a letter kind while issued letters reference it.
- **FR-023**: System MUST restrict access to company documents, signed letters and payment proofs by
  permission, and MUST record who uploaded and who retrieved each.
- **FR-024**: System MUST treat Aadhaar as regulated personal data: retrieval MUST be restricted by
  permission, every retrieval MUST be audit-logged with the retriever and the time, and an Aadhaar
  document MUST NOT be rendered into, attached to, or referenced by any letter template
  (Clarifications, 2026-09-15). These were assumptions until this session; they are requirements now
  because the cost of getting them wrong is legal rather than functional.
- **FR-025**: Every surface in this feature MUST let a caller who may work across companies name the
  company they are acting in, and MUST refuse a cross-company caller who names none rather than
  guessing (Clarifications, 2026-09-16). This is a consistency requirement, not a multi-company
  feature: letter kinds and project document requirements already behave this way, company documents
  and signatories do not, and the difference is invisible until a user with access to two companies
  finds one surface pinned to the wrong one. **Feature 019 FR-008–FR-013 owns the product answer** —
  a persistent switcher at the top of every screen — and supersedes the per-section selector this
  requirement settles for.

### Non-Functional Requirements

- **NFR-001** *(Note 25)*: Document upload and letter issue MUST be operable on Android and iOS
  phones at 320px width, because site staff photograph and upload documents from site rather than
  from a desk. **This is not verified today** — the admin surfaces are desktop-first by existing
  constitutional principle, and this requirement widens that scope deliberately. Confirmation
  requires real-device testing.
- **NFR-002**: A document or letter MUST be retrievable within 3 seconds at the 95th percentile for
  files up to 10 MB. **Not verified today**; no measurement of the existing document paths exists.

### Key Entities

- **Company Document**: A file filed against a company and a kind, with reference number, optional
  expiry, uploader, upload time, and supersession state.
- **Document Kind**: The classification, whether it is required, and whether it expires. Distinct for
  company and project scopes.
- **Letter Kind**: A nameable class of letter, built-in or company-defined, its variable fields, and
  whether it carries a signature.
- **Letter Template**: The fixed wording and terms for a kind, versioned so issued letters remain
  faithful.
- **Issued Letter**: A rendered letter, its recipient, the record it draws from, its version, its
  signature state, and any countersigned copy.
- **Payment Proof**: A file attached to a payment evidencing the transfer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All 8 required company document kinds can be stored and retrieved; KYC completeness is
  reported accurately for a company with any subset present.
- **SC-002**: Project document readiness is visible for every project in the portfolio list without
  opening any of them.
- **SC-003**: All 15 letter kinds in FR-010 can be issued, up from 5 today.
- **SC-004**: A new letter kind can be created and issued by an administrator in under 10 minutes
  with no developer involvement.
- **SC-005**: An issued letter retrieved after its template has been edited renders identically to
  the day it was issued.
- **SC-006**: 100% of recorded payments either carry a transaction proof or are reported as lacking
  one.
- **SC-007**: Every company document expiring within the reminder window raises a reminder, verified
  across a full sweep.

## Assumptions

- Documents are stored through the existing encrypted blob mechanism, inheriting its handling.
- "Digital signature" in Note 19 means an authorised signature image applied to the rendered
  document so it can be sent without printing — not a cryptographic signature under the IT Act.
  **Confirmed with the client on 2026-09-15** (Clarifications); this is no longer an assumption. If
  a legally recognised certificate is ever required, FR-016 and User Story 4 must be rewritten
  rather than extended — the two differ in cost, workflow and legal effect.
- The salary slip already generated by payroll is the same document Note 19 lists; this feature
  brings it under the template mechanism rather than creating a second one.
- Aadhaar is stored because the client asked for it, and **confirmed on 2026-09-15** as staying in
  the required set. It is regulated personal data, so the handling that was assumed here is now
  stated as FR-024 and is testable: permission-restricted retrieval, audit-logged on every read, and
  never rendered into a letter.
- Existing offer and appointment letter behaviour in Recruitment continues unchanged; this feature
  extends the mechanism rather than replacing it.
- Reminders reuse the existing reminder engine rather than introducing a second notification path.

