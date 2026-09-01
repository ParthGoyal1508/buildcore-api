# Feature Specification: Recruitment & Onboarding Backend (Requisitions, Candidates, Interviews, Offers, Joining, Letters, Separation)

**Feature Branch**: `011-recruitment-onboarding-backend`

**Created**: 2026-09-01

**Status**: Draft

**Input**: User description: "Recruitment & Onboarding module for the BuildCore API backend, closing
the gap identified by the module/submodule matrix (row 22 'Recruitment' and the letter-generation
and resignation-report items of row 23 'Exit/F&F'). The matrix names: Open Positions, Interviews,
Selected, Joining Pending, Offer Letter Generation, Employee Onboarding, New Joining Report,
Appointment Letter Generate, Document Verification, Resignation Report, Kit Issue. None of these
exist in any current spec — feature 005 (HR & Payroll) begins at an already-hired Employee record
and has no requisition, candidate, interview, offer, or letter surface at all. This feature owns the
`recruitment` schema and the hiring funnel that terminates in the creation of the Employee record
that 005 then administers, plus the document-template/letter-generation service that 005's
Full & Final flow reuses to produce a relieving letter."

**Scope note**: this feature deliberately stops where feature 005 starts. It does not re-specify
Employee master, payroll, attendance, or the F&F *computation* — it produces the Employee record on
joining, and it provides the letter-generation service 005 calls for relieving letters. The
separation surfaces it owns are the *resignation record and report* (the tracking of who resigned,
when, and why), not the settlement arithmetic.

## Clarifications

### Session 2026-09-01

- Q: Does a candidate exist independently of a requisition, or only against one? → A: Only against
  one. A Candidate is always created under an open Requisition (matrix "Open Positions"), so
  headcount, budget, and department are inherited rather than re-entered. A speculative/walk-in
  applicant is handled by creating a requisition of type `walk_in` for the department.
- Q: What happens to the Candidate record when an offer is accepted and the person joins? → A: The
  Candidate is *retained* and linked to the newly created Employee via `employeeId`, never deleted
  or converted-in-place. The funnel history (which requisition, which interviews, what scores, what
  was offered) must remain auditable after the person becomes an employee.
- Q: Are letters (offer, appointment, relieving) free-text uploads or generated from templates? →
  A: Generated from per-company templates with token substitution, then rendered to PDF and stored
  as an encrypted object-storage reference. A generated letter is immutable once issued; re-issuing
  supersedes the prior version rather than editing it.
- Q: Does Document Verification block the creation of the Employee record on joining? → A: No, it
  blocks *completion* of onboarding, not creation. The Employee record is created on joining so
  attendance and payroll can begin; the onboarding checklist (documents, kit issue) tracks
  separately and 005's existing `hasMissingMandatoryDocs()` gate (002 FR-021, 005 FR-005) already
  prevents attendance for an employee missing mandatory documents.
- Q: Is Kit Issue an inventory transaction against feature 009 stock, or a standalone checklist? →
  A: Standalone checklist in this feature, with an optional link to an inventory issue. Kit items
  (helmet, safety shoes, ID card, laptop) are configured as a Settings-owned master; if the kit
  item names an inventory item, issuing it records the linked `issueId` so stock stays correct,
  otherwise it is tracked as a non-stock issuance.
- Q: Who may see candidate PII (phone, email, resume, expected salary)? → A: Holders of the new
  `RECRUITMENT` permission only. Candidate contact details and expected/offered salary are masked
  in list responses the same way 005 FR-003 masks Aadhaar/PAN/bank details, and unmasked only on
  the single-candidate detail endpoint.

### Session 2026-09-01 (ratification — gap-closure clarify pass)

- Q: Should this feature include candidate-facing surfaces (a careers portal, candidate self-service
  status checking, automated email/SMS delivery of offer letters)? → A: No — internal HR-facing
  backend only. HR generates and downloads letters and delivers them by their own means. A public
  candidate surface would need its own authentication and abuse-control posture and belongs in a
  separate feature.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Raise and manage manpower requisitions (Open Positions) (Priority: P1)

An HR admin or department head raises a requisition for a role — department, designation, number of
positions, employment type, project/site the role is for, target joining date, budgeted CTC range,
and justification. Requisitions are approved before they accept candidates, and the requisition
tracks how many of its positions are still open as candidates are hired against it.

**Why this priority**: Nothing else in the funnel can exist without it — candidates, interviews,
and offers are all scoped to a requisition. No dependencies beyond Settings masters (Department,
Designation) which already exist.

**Independent Test**: Raise a requisition for 3 Site Engineer positions, approve it, confirm it
appears in the Open Positions list with `openPositions: 3` and `filledPositions: 0` — without any
candidate, interview, or offer existing.

**Acceptance Scenarios**:

1. **Given** an admin session, **When** `POST /recruitment/requisitions` is called with
   `departmentId`, `designationId`, `positionCount`, `employmentType`
   (permanent|contract|walk_in), optional `projectId`/`siteId`, `targetJoiningDate`,
   `budgetedCtcMin`, `budgetedCtcMax`, and `justification`, **Then** the requisition is created
   with `status: 'draft'` and an auto-generated `requisitionCode`.
2. **Given** a draft requisition, **When** `PATCH /recruitment/requisitions/:id/submit`, **Then**
   status becomes `pending_approval` and the configured approver is notified.
3. **Given** a `pending_approval` requisition, **When** `PATCH /recruitment/requisitions/:id/approve`
   is called by a holder of `RECRUITMENT_APPROVE`, **Then** status becomes `open` and the
   requisition begins accepting candidates.
4. **Given** a `pending_approval` requisition, **When** `PATCH /recruitment/requisitions/:id/reject`
   is called without a `reason`, **Then** `400 Bad Request`; with a reason, status becomes
   `rejected`.
5. **Given** a requisition with `positionCount: 3` and 3 candidates joined, **When** the third
   joining completes, **Then** the requisition auto-transitions to `closed` and no further
   candidates may be added (`409 Conflict`).
6. **Given** an `open` requisition, **When** `GET /recruitment/requisitions?status=open&departmentId=`,
   **Then** paginated results include `positionCount`, `filledPositions`, `openPositions`,
   `candidateCount`, and `ageInDays`.
7. **Given** a requisition with linked candidates, **When** `DELETE /recruitment/requisitions/:id`
   is attempted, **Then** `409 Conflict`.

---

### User Story 2 - Track candidates through the hiring pipeline (Priority: P1)

A recruiter adds candidates against an open requisition with their contact details, experience,
current and expected salary, source, and resume upload, then moves each candidate through the
pipeline stages. The pipeline is the matrix's "Interviews / Selected / Joining Pending" view: a
single candidate list filtered by stage.

**Why this priority**: The core record of the module; interviews, offers, and joining all hang off
a Candidate. Depends only on US1.

**Independent Test**: Add a candidate to an open requisition, move them from `applied` to
`shortlisted`, confirm the requisition's `candidateCount` increments and the candidate appears
under the `shortlisted` stage filter — without scheduling an interview.

**Acceptance Scenarios**:

1. **Given** an open requisition, **When** `POST /recruitment/candidates` is called with
   `requisitionId`, `fullName`, `phone`, `email`, `totalExperienceYears`, `currentEmployer`,
   `currentCtc`, `expectedCtc`, `source` (referral|agency|walk_in|portal|internal), and optional
   `referredByEmployeeId`, **Then** the candidate is created with `stage: 'applied'`.
2. **Given** a candidate, **When** `POST /recruitment/candidates/:id/resume` uploads a file,
   **Then** the resume is stored as an encrypted object-storage reference.
3. **Given** a candidate list request, **When** `GET /recruitment/candidates?requisitionId=&stage=&search=`,
   **Then** results are paginated and `phone`, `email`, `currentCtc`, and `expectedCtc` are masked
   to their last 4 characters / a redacted band.
4. **Given** a single candidate request by a `RECRUITMENT` holder, **When**
   `GET /recruitment/candidates/:id`, **Then** contact details and salary figures are returned
   unmasked and the access is written to the audit log.
5. **Given** a candidate at stage `applied`, **When** `PATCH /recruitment/candidates/:id/stage` is
   called with `shortlisted`, **Then** the stage advances and a `CandidateStageHistory` row records
   actor, from-stage, to-stage, timestamp, and optional remarks.
6. **Given** a candidate, **When** a stage transition is attempted that is not permitted by the
   pipeline (e.g. `applied` → `joined` directly), **Then** `400 Bad Request` naming the allowed
   next stages.
7. **Given** a candidate at any stage, **When** `PATCH /recruitment/candidates/:id/reject` is called
   with a `rejectionReason`, **Then** stage becomes `rejected` and the candidate no longer counts
   toward the requisition's active pipeline.
8. **Given** a duplicate candidate (same phone or email already on an active candidate for the same
   company), **When** creation is attempted, **Then** `409 Conflict` identifying the existing
   candidate.

---

### User Story 3 - Schedule interviews and record feedback (Priority: P1)

A recruiter schedules one or more interview rounds for a shortlisted candidate, assigns
interviewers, and records each round's feedback and recommendation. A candidate advances to
"Selected" when every scheduled round is complete and the final round recommends selection.

**Why this priority**: The matrix names "Interviews" as a first-class submodule, and the
`selected` stage cannot be reached without round outcomes. Depends on US2.

**Independent Test**: Schedule a technical round for a shortlisted candidate, record a
"recommend" outcome with a score, confirm the round shows as completed and the candidate's
`completedRounds` count increments — without an offer existing.

**Acceptance Scenarios**:

1. **Given** a shortlisted candidate, **When** `POST /recruitment/candidates/:id/interviews` is
   called with `roundNumber`, `roundType` (telephonic|technical|hr|managerial|final),
   `scheduledAt`, `mode` (in_person|phone|video), `interviewerEmployeeIds[]`, and optional
   `location`, **Then** the interview is created with `status: 'scheduled'` and each interviewer
   is notified.
2. **Given** a scheduled interview, **When** a second interview with the same `roundNumber` for
   the same candidate is created, **Then** `409 Conflict`.
3. **Given** a scheduled interview, **When** `PATCH /recruitment/interviews/:id/feedback` is called
   by an assigned interviewer with `outcome` (recommend|hold|reject), `score` (1–10), and
   `comments`, **Then** the interview status becomes `completed` and the feedback is recorded
   against that interviewer.
4. **Given** a scheduled interview, **When** feedback is submitted by an employee who is not an
   assigned interviewer and does not hold `RECRUITMENT`, **Then** `403 Forbidden`.
5. **Given** a scheduled interview, **When** `PATCH /recruitment/interviews/:id/reschedule` is
   called with a new `scheduledAt` and a `reason`, **Then** the interview stays `scheduled`, the
   prior time is retained in history, and `rescheduleCount` increments.
6. **Given** a candidate whose every scheduled round is `completed` and whose final round outcome
   is `recommend`, **When** `PATCH /recruitment/candidates/:id/stage` is called with `selected`,
   **Then** the transition succeeds.
7. **Given** a candidate with an incomplete round, **When** advancing to `selected` is attempted,
   **Then** `400 Bad Request` naming the pending rounds.
8. **Given** an interview scheduled in the past that was never completed, **When** the interview
   list is read, **Then** it is flagged `overdue`.

---

### User Story 4 - Generate and issue offer letters (Priority: P1)

An HR admin builds an offer for a selected candidate — designation, department, offered CTC with
its salary-component breakup, joining date, probation period, notice period, and reporting manager
— then generates the offer letter from the company's template and issues it. The candidate's
acceptance or decline is recorded against the offer.

**Why this priority**: The matrix names "Offer Letter Generation" explicitly, and no candidate can
reach "Joining Pending" without an accepted offer. Depends on US3.

**Independent Test**: Create an offer for a selected candidate, generate the letter, confirm a PDF
is produced with the candidate's name and offered CTC substituted, and confirm the offer moves to
`issued` — without the candidate joining.

**Acceptance Scenarios**:

1. **Given** a candidate at stage `selected`, **When** `POST /recruitment/candidates/:id/offers` is
   called with `designationId`, `departmentId`, `offeredCtc`, `salaryBreakup[]` (component name,
   monthly amount), `proposedJoiningDate`, `probationMonths`, `noticePeriodDays`, and
   `reportingManagerEmployeeId`, **Then** the offer is created with `status: 'draft'`.
2. **Given** a draft offer whose `salaryBreakup[]` component sum does not equal `offeredCtc / 12`,
   **When** generation is attempted, **Then** `400 Bad Request` reporting the difference.
3. **Given** an offer whose `offeredCtc` exceeds its requisition's `budgetedCtcMax`, **When** the
   offer is created, **Then** it is created but flagged `outsideBudget: true` and requires
   `RECRUITMENT_APPROVE` to be issued.
4. **Given** a draft offer, **When** `POST /recruitment/offers/:id/generate`, **Then** the offer
   letter is rendered from the company's active `offer_letter` template with tokens substituted,
   stored as an encrypted object-storage reference, and the offer status becomes `issued`.
5. **Given** an issued offer, **When** `PATCH /recruitment/offers/:id/accept` is called with an
   `acceptedOn` date and optional `confirmedJoiningDate`, **Then** the offer becomes `accepted` and
   the candidate's stage advances to `offer_accepted` (the matrix's "Joining Pending").
6. **Given** an issued offer, **When** `PATCH /recruitment/offers/:id/decline` is called with a
   `declineReason`, **Then** the offer becomes `declined` and the candidate's stage becomes
   `rejected`.
7. **Given** an accepted offer, **When** an edit to `offeredCtc` or `salaryBreakup` is attempted,
   **Then** `409 Conflict` — an accepted offer is immutable and must be revised by issuing a
   revised offer that supersedes it.
8. **Given** a candidate with an issued offer, **When** a second offer is created for the same
   candidate, **Then** the prior offer is marked `superseded` and only the newest offer is active.

---

### User Story 5 - Complete joining and create the Employee record (Priority: P1)

On the confirmed joining date, HR completes the joining: the system creates the Employee record in
the `hr` schema using the accepted offer's terms and the candidate's personal details, auto-assigns
the employee code via Settings' existing code-series service, opens an onboarding checklist, and
links the candidate to the new employee.

**Why this priority**: This is the handoff to feature 005 — the point at which the person becomes
an administrable employee. Depends on US4.

**Independent Test**: Complete joining for a candidate with an accepted offer, confirm an Employee
row exists with the offered designation and a generated employee code, and confirm the candidate's
`employeeId` now points at it — without any document being verified.

**Acceptance Scenarios**:

1. **Given** a candidate at stage `offer_accepted` with an accepted offer, **When**
   `POST /recruitment/candidates/:id/join` is called with `actualJoiningDate`, `dateOfBirth`,
   `gender`, `permanentAddress`, `emergencyContact`, and optional `siteId`, **Then** an Employee
   record is created in the `hr` schema with the offer's designation, department, reporting
   manager, and salary breakup; the employee code is generated via Settings' existing
   `{CompanyShortCode}-{sequence}` series (002 FR-023); the candidate's stage becomes `joined` and
   `employeeId` is set.
2. **Given** the joining request, **When** `actualJoiningDate` is more than a configurable number of
   days after the offer's `confirmedJoiningDate`, **Then** the joining still succeeds but is
   flagged `delayedJoining: true` with the day count.
3. **Given** a candidate already at stage `joined`, **When** joining is attempted again, **Then**
   `409 Conflict`.
4. **Given** a successful joining, **When** the requisition is read, **Then** `filledPositions` has
   incremented and `openPositions` has decremented.
5. **Given** a candidate at stage `offer_accepted` whose joining date has passed by more than a
   configurable grace window with no joining recorded, **When** the pipeline is read, **Then** the
   candidate is flagged `noShow` and appears in the Joining Pending overdue filter.
6. **Given** a candidate at stage `offer_accepted`, **When**
   `PATCH /recruitment/candidates/:id/mark-no-show` is called with a reason, **Then** the stage
   becomes `no_show`, the requisition's open position is released, and the event is audit-logged.
7. **Given** a successful joining, **When** the new-joining report is read for that period, **Then**
   the employee appears with joining date, requisition, source, and offered CTC.

---

### User Story 6 - Run the onboarding checklist: document verification and kit issue (Priority: P2)

After joining, HR works an onboarding checklist for the new employee: verify each required document
against the company's Document Types master, issue kit items, and complete the remaining induction
tasks. Onboarding is complete only when every mandatory item is done.

**Why this priority**: The matrix names "Employee Onboarding", "Document Verification", and "Kit
Issue" as distinct items. It follows joining but does not block it. Depends on US5.

**Independent Test**: For a joined employee, verify a PAN document and issue a helmet from the kit
master, confirm the checklist shows 2 of N items complete and `onboardingComplete: false` — without
completing the remaining items.

**Acceptance Scenarios**:

1. **Given** a completed joining, **When** the employee is created, **Then** an `OnboardingChecklist`
   is opened automatically containing one document item per mandatory Document Type for that
   company (from Settings, 002 FR-019) and one kit item per default kit item.
2. **Given** an onboarding checklist, **When** `GET /recruitment/onboarding/:employeeId`, **Then**
   every item is returned with its type, status (pending|completed|waived), completion actor, and
   completion timestamp, plus a `completedCount`/`totalCount` summary.
3. **Given** a pending document item, **When** `PATCH /recruitment/onboarding/items/:id/verify` is
   called with `documentNumber`, optional `expiryDate`, and a file upload, **Then** the document is
   stored against the employee using 005's existing employee-document surface (005 FR-004), and the
   item becomes `completed`.
4. **Given** a document item verified with a `documentNumber` that fails its Document Type's
   configured format, **When** verification is attempted, **Then** `400 Bad Request`.
5. **Given** a pending kit item whose kit master entry names an inventory item, **When**
   `PATCH /recruitment/onboarding/items/:id/issue` is called with `quantity`, **Then** an inventory
   issue is recorded against the employee's site and the item stores the resulting `issueId`.
6. **Given** a pending kit item with no linked inventory item, **When** it is issued, **Then** it is
   recorded as a non-stock issuance with the issuing actor and date, and no inventory movement
   occurs.
7. **Given** an item a company does not require for a particular hire, **When**
   `PATCH /recruitment/onboarding/items/:id/waive` is called with a `waiverReason` by a holder of
   `RECRUITMENT_APPROVE`, **Then** the item becomes `waived` and stops blocking completion.
8. **Given** every mandatory item is `completed` or `waived`, **When** the checklist is read,
   **Then** `onboardingComplete: true` and the completion date is recorded.
9. **Given** an employee whose mandatory document items are still pending, **When** attendance is
   marked for them, **Then** the existing Settings gate (002 FR-021) rejects it — this feature adds
   no second gate.

---

### User Story 7 - Generate appointment, confirmation, and relieving letters (Priority: P2)

HR maintains per-company letter templates with substitution tokens and generates letters from them:
an appointment letter on joining, a confirmation letter at the end of probation, and a relieving
letter at separation. Every generated letter is versioned, immutable once issued, and downloadable.

**Why this priority**: The matrix names "Appointment Letter Generate" (row 22) and "Generate
relieving letter" (row 23). It is also the service feature 005's F&F flow calls. Depends on US5 for
appointment letters; the relieving letter depends on US8.

**Independent Test**: Create an appointment-letter template with `{{employeeName}}` and
`{{designation}}` tokens, generate it for a joined employee, confirm the PDF contains the
substituted values and a second generation produces version 2 while version 1 remains
downloadable.

**Acceptance Scenarios**:

1. **Given** an admin session, **When** `POST /recruitment/letter-templates` is called with
   `letterType` (offer|appointment|confirmation|relieving|experience), `name`, `bodyTemplate`, and
   optional `letterheadAssetId`, **Then** the template is created and validated so that every token
   it references exists in that letter type's documented token set.
2. **Given** a template referencing an unknown token, **When** it is saved, **Then** `400 Bad
   Request` naming the unknown tokens.
3. **Given** a company with two templates of the same `letterType`, **When** one is marked active,
   **Then** the other is automatically deactivated — exactly one template per type per company is
   active.
4. **Given** an active appointment template and a joined employee, **When**
   `POST /recruitment/letters` is called with `letterType: 'appointment'` and `employeeId`, **Then**
   the letter is rendered with tokens substituted from live employee, offer, and company data,
   stored as an encrypted object-storage reference with `version: 1`, and marked `issued`.
5. **Given** an issued letter, **When** an edit to its rendered content is attempted, **Then**
   `409 Conflict` — letters are immutable.
6. **Given** an issued letter, **When** `POST /recruitment/letters` is called again for the same
   employee and letter type, **Then** a new version is created, the prior version is marked
   `superseded`, and both remain downloadable.
7. **Given** an issued letter, **When** `GET /recruitment/letters/:id/download` is called by a
   holder of `RECRUITMENT`, **Then** the PDF is streamed and the access is audit-logged.
8. **Given** a relieving letter requested for an employee whose F&F settlement is not yet processed,
   **When** generation is attempted, **Then** `409 Conflict` — a relieving letter requires a
   processed F&F run (005 FR-033).

---

### User Story 8 - Record resignations and produce the resignation report (Priority: P2)

An employee's resignation is recorded with its date, reason, notice period served or waived, and
last working day. The record drives the separation pipeline view and the resignation report, and it
is the trigger that feature 005's exit/F&F flow consumes.

**Why this priority**: The matrix names "Resignation report" under Exit/F&F, and 005's exit flow
(FR-031) captures an exit but has no resignation record, reason taxonomy, or report. Depends on
005's Employee record.

**Independent Test**: Record a resignation for an active employee with a 30-day notice period,
confirm the computed last working day and that the employee appears in the resignation report for
that month — without running F&F.

**Acceptance Scenarios**:

1. **Given** an active employee, **When** `POST /recruitment/resignations` is called with
   `employeeId`, `resignationDate`, `reasonCategory` (better_opportunity|personal|relocation|
   health|compensation|work_environment|other), `reasonDetail`, and `noticePeriodDays`, **Then**
   the resignation is created with `status: 'submitted'` and a computed
   `expectedLastWorkingDay = resignationDate + noticePeriodDays`.
2. **Given** a submitted resignation, **When** `PATCH /recruitment/resignations/:id/accept` is called
   with an optional `agreedLastWorkingDay` and, when that date is earlier than the expected one, a
   `noticeWaiverDays` value and reason, **Then** status becomes `accepted` and the agreed last
   working day is stored.
3. **Given** an accepted resignation, **When** feature 005's exit flow is initiated for that
   employee, **Then** it reads the agreed last working day and notice-waiver days from this record
   rather than re-collecting them.
4. **Given** a submitted resignation, **When** `PATCH /recruitment/resignations/:id/withdraw` is
   called with a reason before the last working day, **Then** status becomes `withdrawn` and the
   employee remains active.
5. **Given** an employee with an accepted resignation, **When** a second resignation is created,
   **Then** `409 Conflict`.
6. **Given** a period and optional department/project filter, **When**
   `GET /recruitment/reports/resignations?from=&to=&departmentId=`, **Then** the report returns each
   separated employee with joining date, resignation date, last working day, tenure in months,
   reason category, and whether F&F is settled, plus aggregate counts by reason category and a
   computed attrition rate for the period.
7. **Given** an accepted resignation whose last working day has passed with no F&F run, **When** the
   report is read, **Then** the row is flagged `settlementPending`.

---

### User Story 9 - Recruitment reporting and funnel analytics (Priority: P3)

HR views the new-joining report and a recruitment funnel summary showing how many candidates sit at
each stage per requisition, along with time-to-hire and source effectiveness.

**Why this priority**: The matrix names "New joining report" explicitly; the funnel view is the
"Open Positions / Interviews / Selected / Joining Pending" summary the matrix implies. Reporting is
valuable but every underlying record must exist first.

**Independent Test**: With one joined and two in-pipeline candidates, read the funnel report and
confirm the stage counts and average time-to-hire match the recorded stage history.

**Acceptance Scenarios**:

1. **Given** a period, **When** `GET /recruitment/reports/new-joinings?from=&to=&departmentId=&projectId=`,
   **Then** every employee who joined in the period is returned with employee code, name,
   designation, department, project/site, joining date, source, requisition code, and offered CTC.
2. **Given** a period, **When** `GET /recruitment/reports/funnel?from=&to=`, **Then** counts per
   stage (applied, shortlisted, interviewing, selected, offer_issued, offer_accepted, joined,
   rejected, no_show) are returned with conversion percentages between consecutive stages.
3. **Given** joined candidates in the period, **When** the funnel report is read, **Then**
   `averageTimeToHireDays` is computed from each candidate's `applied` stage-history timestamp to
   their `joined` timestamp.
4. **Given** candidates from multiple sources, **When** the funnel report is read, **Then** a
   per-source breakdown reports candidates added, offers accepted, and joined for each source.
5. **Given** any recruitment report, **When** `?format=xlsx` or `?format=pdf` is requested, **Then**
   a real file is produced using the project's existing export libraries and, when the row count
   exceeds the configured synchronous threshold, generated asynchronously as a background job the
   same way 004 FR-021 handles large exports.
6. **Given** a caller without `REPORTS`, **When** any recruitment report is requested, **Then**
   `403 Forbidden`.

---

### Edge Cases

- A requisition is closed while candidates are still mid-interview → the candidates remain readable
  and their existing interviews may be completed, but no new offer may be issued against a closed
  requisition (`409`); reopening the requisition requires `RECRUITMENT_APPROVE`.
- A candidate is referred by an employee who later leaves → the referral link is retained; the
  report shows the referrer's name with an `inactive` marker rather than dropping the row.
- Two recruiters try to advance the same candidate's stage concurrently → the stage transition is
  applied under a row-level lock so exactly one succeeds; the loser receives `409 Conflict` with
  the current stage.
- An offer letter template is edited after letters were generated from it → already-issued letters
  keep their rendered content; the template edit affects only subsequent generations.
- A candidate joins, then their joining is found to be erroneous → there is no delete; the
  correction path is 005's employee-deactivation flow, and the candidate's stage history retains
  the joined transition.
- The same person applies again after being rejected → allowed; the duplicate check only blocks
  duplicates against *active* candidates, and the new candidate row links to the prior one as
  `previousCandidateId`.
- A kit item is issued, then the employee is a no-show for their remaining onboarding → issued kit
  items remain recorded so recovery can be tracked at F&F.
- An interviewer is assigned to their own relative's interview → out of scope for automated
  detection; the audit log records who submitted each feedback.
- Letter generation is attempted when no active template exists for that letter type → `409
  Conflict` naming the missing template type, never a silently blank document.
- A resignation is recorded for an employee who is already inactive → `409 Conflict`.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All `recruitment` schema tables MUST carry `companyId` with RLS enforcing tenant
  isolation, following the constitution's multi-tenant isolation principle and matching how every
  other module in this project scopes its tables.
- **FR-002**: The system MUST auto-generate `requisitionCode` via Settings' existing code-series
  service, using the same `{CompanyShortCode}-{prefix}-{sequence}` mechanism that generates
  employee codes (002 FR-023), rather than introducing a second numbering scheme.
- **FR-003**: A Candidate MUST always belong to exactly one Requisition; the system MUST reject
  candidate creation against a requisition whose status is not `open` with `409 Conflict`.
- **FR-004**: The system MUST enforce the candidate pipeline as an explicit state machine —
  `applied → shortlisted → interviewing → selected → offer_issued → offer_accepted → joined`, with
  `rejected` reachable from any pre-joined stage and `no_show` reachable only from
  `offer_accepted` — rejecting any transition outside it with `400 Bad Request` that names the
  permitted next stages.
- **FR-005**: Every candidate stage transition MUST be recorded in a `CandidateStageHistory` row
  capturing actor, from-stage, to-stage, timestamp, and optional remarks; history rows MUST be
  immutable.
- **FR-006**: The system MUST mask candidate `phone`, `email`, `currentCtc`, and `expectedCtc` in
  all list responses and return them unmasked only from the single-candidate detail endpoint,
  mirroring the PII-masking rule 005 FR-003 applies to Aadhaar/PAN/bank details.
- **FR-007**: The system MUST reject creation of a candidate whose phone or email matches an
  existing non-rejected, non-no-show candidate in the same company with `409 Conflict` identifying
  the existing record.
- **FR-008**: A candidate MUST NOT advance to `selected` while any scheduled interview round for
  them is not `completed`; the rejection MUST name the pending rounds.
- **FR-009**: Interview feedback MUST be accepted only from an assigned interviewer or a holder of
  `RECRUITMENT`, and MUST be recorded per-interviewer so a multi-interviewer round retains each
  individual's outcome, score, and comments.
- **FR-010**: The system MUST reject an offer whose `salaryBreakup[]` monthly component sum does not
  equal `offeredCtc / 12` within a configurable rounding tolerance, reporting the difference.
- **FR-011**: An offer whose `offeredCtc` exceeds its requisition's `budgetedCtcMax` MUST be flagged
  `outsideBudget` and MUST require `RECRUITMENT_APPROVE` to reach `issued`.
- **FR-012**: An `accepted` offer MUST be immutable; revisions MUST be made by issuing a new offer
  that marks the prior one `superseded`, and at most one offer per candidate may be active at a
  time.
- **FR-013**: On joining, the system MUST create the Employee record in the `hr` schema within a
  single transaction that also sets the candidate's `employeeId`, advances the stage to `joined`,
  increments the requisition's `filledPositions`, and opens the onboarding checklist — a partial
  joining MUST NOT be observable.
- **FR-014**: A requisition MUST auto-transition to `closed` when `filledPositions` reaches
  `positionCount`, and MUST release an open position when a candidate is marked `no_show`.
- **FR-015**: The system MUST open an `OnboardingChecklist` on joining, seeded with one item per
  mandatory Document Type configured for the company (from Settings, 002 FR-019) and one item per
  default kit item from the Kit Items master.
- **FR-016**: Document verification MUST store the verified document against the employee through
  005's existing employee-document surface (005 FR-004) rather than creating a parallel document
  store, and MUST validate the supplied `documentNumber` against its Document Type's configured
  format.
- **FR-017**: The system MUST NOT introduce a second attendance gate for missing documents — the
  existing Settings gate (002 FR-021, enforced via 005 FR-005) remains the single enforcement
  point; onboarding completion is tracked but does not itself block attendance.
- **FR-018**: A kit item whose master entry names an inventory item MUST record an inventory issue
  and store the resulting `issueId`; a kit item with no linked inventory item MUST be recorded as a
  non-stock issuance with actor and date, and MUST NOT create any inventory movement.
- **FR-019**: An onboarding item MUST be waivable only by a holder of `RECRUITMENT_APPROVE` and only
  with a non-empty `waiverReason`; a waived item MUST NOT block onboarding completion.
- **FR-020**: Letter templates MUST be validated at save time so that every substitution token they
  reference belongs to the documented token set for that letter type, rejecting unknown tokens with
  `400 Bad Request`.
- **FR-021**: At most one letter template per `letterType` per company may be active; activating a
  template MUST atomically deactivate the previously active one of that type.
- **FR-022**: A generated letter MUST be immutable once `issued`; regeneration MUST create a new
  version, mark the prior version `superseded`, and keep every version downloadable.
- **FR-023**: A relieving letter MUST NOT be generatable until the employee's F&F run is processed
  (005 FR-033); the attempt MUST be rejected with `409 Conflict`.
- **FR-024**: All candidate resumes, generated letters, and verified onboarding documents MUST be
  stored as encrypted object-storage references using the same mechanism as 003's biometric blobs
  and 006's equipment documents, and the system MUST refuse to start in production when configured
  to store these blobs on the local filesystem (matching 003 FR-026a).
- **FR-025**: Feature 005's exit flow MUST source `lastWorkingDay` and notice-waiver days from an
  `accepted` Resignation record when one exists, rather than re-collecting them; this feature MUST
  export a service method for that lookup.
- **FR-026**: The system MUST reject a resignation for an employee who is already inactive, and MUST
  reject a second resignation for an employee with an existing `submitted` or `accepted` one, both
  with `409 Conflict`.
- **FR-027**: The resignation report MUST compute tenure in months from the employee's joining date
  to their last working day, and MUST compute the period attrition rate as separations in the
  period divided by average active headcount over that period.
- **FR-028**: The funnel report MUST compute `averageTimeToHireDays` from each joined candidate's
  `applied` stage-history timestamp to their `joined` timestamp, never from record-creation
  timestamps.
- **FR-029**: Report exports MUST produce real XLSX/PDF files using the project's existing export
  libraries, and MUST be generated asynchronously as a background job when the row count exceeds
  the configured synchronous threshold, matching 004 FR-021.
- **FR-030**: Every endpoint in this feature MUST be gated by `JwtAuthGuard` plus a
  `@RequirePermission()` check, using the new `RECRUITMENT` and `RECRUITMENT_APPROVE` permissions
  for funnel operations and the existing `REPORTS` permission for report endpoints.
- **FR-031**: The `Permission` enum MUST be extended with exactly two new values — `RECRUITMENT`
  (manage requisitions, candidates, interviews, offers, onboarding, letters) and
  `RECRUITMENT_APPROVE` (approve requisitions, issue outside-budget offers, waive onboarding
  items) — reusing the existing `EMPLOYEES` and `REPORTS` values everywhere else rather than
  inventing further values.
- **FR-032**: All write operations MUST be written to the audit log with new entity types
  `REQUISITION`, `CANDIDATE`, `INTERVIEW`, `OFFER`, `ONBOARDING_ITEM`, `LETTER`, and `RESIGNATION`,
  and every unmasked read of candidate PII or letter download MUST also be audit-logged.
- **FR-033**: Every endpoint in this feature MUST accept and return validated, typed request/
  response DTOs per the constitution's validated-DTO-contracts principle.
- **FR-034**: Candidate stage transitions MUST be applied under a row-level lock so concurrent
  transitions cannot both succeed; the losing request MUST receive `409 Conflict` reporting the
  current stage.
- **FR-035**: The system MUST flag a candidate at `offer_accepted` as `noShow` in list responses
  once their confirmed joining date has passed by more than the configured grace window, without
  changing their stage automatically.
- **FR-036**: Requisition, candidate, offer, and resignation records MUST NOT be hard-deleted;
  removal MUST be a soft-delete that preserves funnel history and report accuracy.
- **FR-037**: The system MUST provide per-company CRUD for the Kit Items master (name, optional
  linked inventory item, default issue quantity, whether it is issued by default on joining, and
  whether it is recoverable at exit), stored in the `settings` schema alongside this project's
  other reference-data masters rather than in `recruitment`.

### Key Entities

- **Requisition**: An approved request to hire N people for a role. Carries department,
  designation, position count, employment type, optional project/site, target joining date,
  budgeted CTC range, justification, status, and derived filled/open position counts.
- **Candidate**: A person in the hiring funnel for exactly one requisition. Carries personal and
  contact details, experience, current/expected CTC, source, optional referrer, resume reference,
  current stage, and — once hired — a link to the created Employee.
- **CandidateStageHistory**: An immutable record of one stage transition: actor, from-stage,
  to-stage, timestamp, remarks. The source of truth for time-to-hire analytics.
- **Interview**: One scheduled round for a candidate: round number, type, scheduled time, mode,
  location, assigned interviewers, status, and reschedule history.
- **InterviewFeedback**: One interviewer's outcome, score, and comments for one interview.
- **Offer**: The proposed terms for a selected candidate: designation, department, CTC, salary
  component breakup, joining date, probation, notice period, reporting manager, outside-budget
  flag, status, and the generated letter reference.
- **OnboardingChecklist / OnboardingItem**: The post-joining task list for a new employee. Each item
  is a document-verification, kit-issue, or induction task with a status, completing actor,
  timestamp, optional waiver reason, and optional linked inventory issue.
- **LetterTemplate**: A per-company, per-type letter body with substitution tokens and an optional
  letterhead asset. Exactly one active template per type per company.
- **GeneratedLetter**: An immutable, versioned rendered letter for an employee or candidate, stored
  as an encrypted object-storage reference with its issue date and superseded flag.
- **Resignation**: An employee's separation record: resignation date, reason category and detail,
  notice period, expected and agreed last working day, notice waiver, and status.
- **KitItem** *(settings schema)*: A per-company issuable item, optionally linked to an inventory
  item, with a default quantity, a default-on-joining flag, and a recoverable-at-exit flag.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A recruiter can take a candidate from first entry through interview, offer, and
  joining without leaving the module or re-entering any detail already captured on the requisition
  or offer.
- **SC-002**: 100% of candidate stage changes are reconstructable after the fact from stage history,
  including who made each change and when.
- **SC-003**: An offer letter, appointment letter, and relieving letter can each be produced as a
  downloadable PDF with correct substituted values in under 10 seconds for a single employee.
- **SC-004**: No candidate contact detail or salary figure appears unmasked in any list response, as
  verified by a test that asserts masking across every candidate-listing endpoint.
- **SC-005**: The requisition's open-position count always equals `positionCount` minus joined
  candidates, verified under concurrent joining attempts against the same requisition.
- **SC-006**: A new employee created by this feature is immediately administrable by feature 005 —
  attendance, leave, and payroll all resolve the employee without any additional data entry beyond
  the onboarding checklist.
- **SC-007**: The resignation report reconciles exactly with feature 005's exit records: every
  employee 005 shows as exited in a period appears in the resignation report for that period.
- **SC-008**: Time-to-hire and funnel conversion figures recomputed from raw stage history match the
  report's returned values exactly.

## Assumptions

- The hiring funnel is linear per candidate — a candidate is considered for one requisition at a
  time. Considering the same person for a second role means creating a second candidate record
  linked via `previousCandidateId`.
- Letter templates are plain-text/HTML bodies with `{{token}}` substitution, not a WYSIWYG document
  editor. Rich formatting beyond what the PDF renderer supports is out of scope.
- Candidate-facing surfaces (a careers portal, candidate self-service status checking, email/SMS
  delivery of offer letters) are out of scope; this feature covers the internal HR-facing backend
  only. Letters are generated and downloaded by HR, who deliver them by their own means.
- Interview scheduling does not integrate with any external calendar system; interviewers are
  notified through the existing in-app notification mechanism (004).
- Background verification, reference checks, and psychometric assessment are out of scope.
- The `hr` schema's Employee model is extended by feature 005; this feature writes to it but does
  not own it. Any field this feature needs that 005 does not already define is a dependency on 005,
  not a new model here.
- The Kit Items master's optional inventory link depends on feature 009 (Inventory) being built;
  until it is, kit items behave as non-stock issuances and the linked-issue path is inert.
- Attrition rate is computed on the simple headcount basis defined in FR-027; annualised or
  cohort-based attrition variants are out of scope.
