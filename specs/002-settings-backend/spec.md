# Feature Specification: Settings Module Backend (Companies, Users, Roles & Reference Data)

**Feature Branch**: `002-settings-backend`

**Created**: 2026-08-27

**Status**: Draft

**Input**: User description: "Settings Module (Companies, Users, Roles & Permissions, Employee
Setup reference data) for the BuildCore API backend, per the PRD at
/Users/parthgoyal/Projects/ERP-Demo/docs/prd/08-settings.prd.md. This is the API/backend surface
only: multi-company configuration with per-company statutory and payroll settings, user
management, role-based access control (RBAC) enforced server-side, and reference data masters
(code series, departments, designations, document types, shifts) that other modules depend on."

## Clarifications

### Session 2026-08-27

- Q: Employee Setup reference-data masters (Departments, Designations, Document Types, Shifts) —
  scoped per-company or shared globally? → A: Per-company — each company maintains its own list,
  consistent with the strict company_id isolation NFR and with Code Series already being
  company-wise.
- Q: Can the built-in Super Admin role be edited or deleted like any other role? → A: Protected/
  immutable — Super Admin's name and full-access permission set cannot be changed and it cannot be
  deleted. All other default and custom roles remain fully editable and deletable.
- Q: Are Role permissions a fixed, system-defined set or freeform text? → A: Fixed enumerated set —
  permissions are chosen from a system-defined list of module/action identifiers, stored as
  structured data, and server-side RBAC checks only recognize known values.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure a company and its statutory/payroll settings (Priority: P1)

A Super Admin creates a company record — basic info, registration numbers, address, statutory
codes, and payroll contribution rates — making it selectable everywhere else in the system, and can
later edit those settings as registrations or statutory rates change.

**Why this priority**: Every other record in the system (users, employees, payroll, reference
data) is scoped to a company. Nothing else in this feature — or in any other module — can be
meaningfully created or tested until at least one company exists.

**Independent Test**: Can be fully tested by creating a company with a unique short code and a full
set of registration/statutory/payroll fields, confirming it appears in the company list and becomes
selectable by other modules, then editing its payroll contribution rates and confirming the new
values are what subsequent calculations would read.

**Acceptance Scenarios**:

1. **Given** no companies exist yet, **When** a Super Admin creates the first company with a name,
   short code, and required registration details, **Then** the company is created active and
   becomes the default company for the bootstrap Super Admin account.
2. **Given** an existing company, **When** its short code is changed, **Then** the change is
   accepted only if the new short code is still unique across all companies (existing employee
   codes already generated under the old short code are not retroactively changed).
3. **Given** an existing company, **When** its PF/ESIC/Gratuity/Bonus contribution rates or Payroll
   Lock Day are updated, **Then** the new values are persisted and immediately available to any
   module that reads them, without requiring a code release.
4. **Given** an existing company, **When** its Status is toggled to Inactive, **Then** it is
   excluded from selection in company-scoped dropdowns elsewhere in the system, but its historical
   data and configuration remain intact and viewable.
5. **Given** a request to create or edit a company, **When** the GSTIN, PAN, or PIN Code fields are
   filled, **Then** they are validated against their respective standard formats before the record
   is saved.

---

### User Story 2 - Manage roles and their permissions (Priority: P1)

A Super Admin views the system's roles (the shipped defaults plus any custom roles), creates new
roles or edits existing ones by selecting permissions from the system's known permission set, and
sees how many users currently hold each role.

**Why this priority**: Role definitions must exist before user administration (User Story 3) can
meaningfully assign roles, and server-side permission enforcement across every other module depends
on this data being correct and trustworthy.

**Independent Test**: Can be fully tested by listing the shipped default roles and their
permissions, creating a new custom role with a chosen subset of permissions, assigning it to a
test user, and confirming that user's accessible modules match exactly what the role grants.

**Acceptance Scenarios**:

1. **Given** a fresh system, **When** the roles list is viewed, **Then** all nine default roles
   (Super Admin, Site Admin, Project Manager, HO User, Accountant, Site Engineer, Store Keeper,
   Site User, Viewer) are present with their documented default permissions and a per-role count of
   currently assigned users.
2. **Given** a Super Admin creating or editing a role, **When** permissions are selected, **Then**
   only values from the system's known permission set are accepted — an unrecognized permission
   identifier is rejected.
3. **Given** the Super Admin role, **When** any attempt is made to rename it, reduce its permission
   set, or delete it, **Then** the request is rejected, regardless of who makes it.
4. **Given** a non-Super-Admin default or custom role, **When** a Super Admin edits its permissions
   or deletes it, **Then** the change succeeds and takes effect; if it is deleted while users are
   still assigned to it, those users' role assignment is cleared and they lose all module access
   until reassigned.
5. **Given** an authenticated user, **When** their role's permissions are changed by an admin,
   **Then** the change is enforced starting with that user's next authenticated request — not only
   after their session naturally expires.

---

### User Story 3 - Administer existing user accounts (Priority: P2)

A Super Admin or HO User views the list of user accounts, searches/filters it, edits a user's
assigned role or active/inactive status, and removes an account that should no longer have access.
(Creating a new account is handled by `010-account-creation-backend`; this feature administers
accounts that already exist, including `pending` ones awaiting activation — see that feature's
spec for the invite lifecycle itself.)

**Why this priority**: Depends on Story 2 (roles must exist to assign) and on accounts already
being created elsewhere; important for day-to-day access management but the system is already
functional without it once a bootstrap Super Admin exists.

**Independent Test**: Can be fully tested by listing existing user accounts with their role, status,
and last-login timestamp, changing one account's role and confirming it's reflected immediately,
deactivating another and confirming it can no longer authenticate, and deleting a third.

**Acceptance Scenarios**:

1. **Given** existing user accounts, **When** the user list is viewed, **Then** each row shows
   name, email, current role, active/inactive status, and last-login timestamp (or "Never" if the
   account has not yet signed in).
2. **Given** an existing user account, **When** an admin changes its assigned role or toggles its
   status to Inactive, **Then** the change is persisted and is enforced on that account's very next
   authenticated request.
3. **Given** an existing user account, **When** an admin deletes it, **Then** the account can no
   longer authenticate and it no longer appears in the user list or in that role's assigned-user
   count.
4. **Given** a non-Super-Admin, non-HO-User admin attempting to reach any user-administration
   endpoint, **When** the request is made, **Then** it is rejected regardless of what the request
   body contains.
5. **Given** an account belonging to a specific company, **When** its list/edit/delete is
   requested, **Then** the operation is scoped to that account's own company and never exposes or
   modifies an account in a different company (except where the acting user is a cross-company
   Super Admin).
6. **Given** a `pending` account (created but not yet activated, per
   `010-account-creation-backend`'s invite flow), **When** the user list is viewed, **Then** it
   appears alongside active/deactivated accounts with a `pending` status and its invite's
   expiry shown; **When** an admin attempts `PATCH .../:id` with `{ status: 'active' }` directly
   against it, **Then** `400` is returned — a pending account can only activate via the invitee
   completing set-password (010's flow), never an admin's direct status write.

---

### User Story 4 - Maintain Departments and Designations masters (Priority: P2)

An admin maintains a per-company list of Departments and a per-company list of Designations, which
populate the corresponding dropdowns on Employee forms elsewhere in the system.

**Why this priority**: Simple, independent CRUD masters that unblock the Employees module's forms;
useful as soon as a company exists, but not required for Stories 1–3 to function.

**Independent Test**: Can be fully tested by adding a department and a designation under one
company, confirming they appear in that company's dropdown data and do not appear under a different
company, then editing and deleting each.

**Acceptance Scenarios**:

1. **Given** a company, **When** an admin adds a Department or Designation name under it, **Then**
   it becomes available in that company's Employee-form dropdown data and is not visible under any
   other company.
2. **Given** an existing Department or Designation, **When** it is renamed, **Then** existing
   Employee records referencing it reflect the updated name (the reference is by identifier, not by
   copied text).
3. **Given** a Department or Designation currently referenced by at least one Employee record,
   **When** deletion is attempted, **Then** the deletion is rejected until no Employee record
   references it.

---

### User Story 5 - Maintain Document Types with mandatory/expiry/number flags (Priority: P3)

An admin maintains a per-company list of document types, each with independently toggled Mandatory,
Has Expiry Date, and Needs Document Number flags plus a sort order, which together determine each
employee's document checklist and gate whether that employee's attendance can be marked.

**Why this priority**: Depends on a company existing; more involved than the plain masters in
Story 4 due to its derived flags and downstream attendance-gating effect, and less immediately
blocking than roles/users/companies.

**Independent Test**: Can be fully tested by creating a document type with Mandatory and Needs
Document Number both on, confirming its derived flag reads "MandatoryNumber", and confirming an
employee missing that mandatory document type cannot have attendance marked.

**Acceptance Scenarios**:

1. **Given** the toggle combination on a document type, **When** it is saved, **Then** the derived
   flag is computed deterministically: Mandatory+Number → MandatoryNumber, Mandatory only →
   Mandatory, Expiry+Number → ExpiryNumber, Expiry only → Expiry, Number only → Number, none →
   Optional.
2. **Given** a new company, **When** it is created, **Then** it is seeded with the system's default
   document types (Aadhaar, PAN, Bank Proof, Photo, Driving Licence, Marksheets, Degree, Experience
   Letter, Medical Fitness, Police Verification, Offer Letter, Appointment Letter, Joining Letter,
   PF Form 11, PF Form 2, ESIC Family Declaration) with their documented default flags, and an admin
   may edit or deactivate any of them thereafter.
3. **Given** an employee missing one or more document types flagged Mandatory for their company,
   **When** an attempt is made to mark that employee's attendance, **Then** the attempt is rejected
   until the missing mandatory document(s) are recorded.
4. **Given** a document type, **When** its Active flag is turned off, **Then** it no longer appears
   as selectable for new document uploads but historical records referencing it are unaffected.

---

### User Story 6 - Maintain Shifts (Priority: P3)

An admin maintains a per-company list of shift definitions (name, in-time, out-time, grace period),
which populate the Shift dropdown on Employee forms and are used by attendance/overtime calculation
elsewhere in the system.

**Why this priority**: A straightforward per-company master, needed before overtime calculations can
be meaningful but independent of Stories 1–5.

**Independent Test**: Can be fully tested by creating a shift with an in-time, out-time, and grace
period under one company, confirming it appears in that company's Shift dropdown data, and
confirming the stored duration is what a downstream overtime calculation would read.

**Acceptance Scenarios**:

1. **Given** a company, **When** an admin creates a shift with a name, in-time, out-time, and grace
   period, **Then** it becomes available in that company's Employee-form Shift dropdown.
2. **Given** an existing shift referenced by at least one Employee record, **When** deletion is
   attempted, **Then** the deletion is rejected until no Employee record references it.

---

### User Story 7 - Auto-generate employee codes from a company's code series (Priority: P3)

The system generates each new employee's code from their company's short code and a per-company
sequential number (e.g., DC-0001, DI-0001), and an admin can view a company's current code-series
state.

**Why this priority**: Depends on Story 1 (a company and its short code must exist); this is the
smallest, most mechanical piece of Employee Setup and has no independent UI beyond a read view.

**Independent Test**: Can be fully tested by requesting the next employee code for a company twice
in a row and confirming the sequence number increments by exactly one each time with no
collision, even in concurrent requests.

**Acceptance Scenarios**:

1. **Given** a company with short code "DC" and no employees yet, **When** the first employee code
   is generated for it, **Then** the result is "DC-0001".
2. **Given** a company that already has employee codes generated, **When** two employee-creation
   requests for that company happen concurrently, **Then** each receives a distinct, sequential
   code with no duplicates and no gaps caused by the race itself.
3. **Given** a company's short code is changed after employee codes already exist, **When** the next
   code is generated, **Then** it uses the new short code while the sequence number continues from
   where it left off (previously generated codes are not renumbered).

---

### Edge Cases

- What happens when a Super Admin's own account is the one being edited/deleted/deactivated by
  another Super Admin? The system must not allow the last remaining active Super Admin account to
  be deactivated, deleted, or have its role reassigned away, to prevent total lockout.
- What happens when a company short code collides with an existing one (including case-insensitive
  or whitespace-variant collisions)? The create/edit request must be rejected before the record is
  saved.
- What happens to a role's assigned-user count and to users' access when a role they hold is
  deleted mid-session? Per User Story 2, their role assignment is cleared and enforcement picks
  this up on their next authenticated request, not immediately server-side.
- What happens when Employee Setup reference data (department, designation, document type, shift)
  is looked up for a company that has none configured yet? The dropdown data returns empty rather
  than falling back to another company's list, since these masters are strictly per-company.
- What happens when a document type's flags are edited after employees already have documents
  recorded against it (e.g., Mandatory is turned on for a type that previously wasn't)? Newly
  mandatory requirements apply going forward to attendance-marking checks; already-marked
  attendance is not retroactively invalidated.
- What happens when the last company is deactivated while active users still reference it? The
  deactivation itself is allowed (a company doesn't require zero users to go inactive), but those
  users lose access along with everyone else scoped to that company per its inactive-company
  exclusion behavior — this is an accepted consequence of deactivation, not a blocking condition.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow a Super Admin to create a company with a name, a globally
  unique short code, an active/inactive status, registration fields (GSTIN, PAN, CIN, TAN), address
  fields (address, city, state, PIN code), statutory fields (PF Establishment Code, ESIC Code,
  Professional Tax Registration Number, BOCW Registration Number), and payroll settings (Payroll
  Lock Day, PF/ESIC/Gratuity/Bonus contribution rates), and to edit any of these fields afterward.
- **FR-002**: The system MUST default a new company's PF Employer Contribution Rate to 12%, ESIC
  Employer Contribution Rate to 3.25%, Gratuity Rate to 4.81%, and Bonus Rate to 8.33%, all of which
  MUST remain admin-editable per company without requiring a code release.
- **FR-003**: The system MUST validate GSTIN and PAN against their standard statutory formats and
  reject a create/edit request containing a malformed value.
- **FR-004**: The system MUST reject a company create/edit request whose short code collides
  (case-insensitively, whitespace-trimmed) with another company's short code.
- **FR-005**: The system MUST exclude Inactive companies from company-selection dropdowns exposed
  to other modules while preserving their stored data and configuration unchanged.
- **FR-006**: The system MUST maintain a Roles master seeded with the nine default roles (Super
  Admin, Site Admin, Project Manager, HO User, Accountant, Site Engineer, Store Keeper, Site User,
  Viewer) and their documented default permission sets on first setup.
- **FR-007**: The system MUST restrict a role's permissions field to a system-defined, enumerated
  set of module/action permission identifiers, rejecting any value outside that set.
- **FR-008**: The system MUST allow a Super Admin to create custom roles and to edit or delete any
  role except Super Admin, whose name and permission set MUST be immutable and MUST NOT be
  deletable by any request.
- **FR-009**: The system MUST report, for every role, the current count of user accounts assigned
  to it.
- **FR-010**: The system MUST clear a user's role assignment (leaving them without module access
  until reassigned) when the role they hold is deleted, rather than leaving a dangling reference.
- **FR-011**: The system MUST enforce every role's permission set server-side on every API request
  to any module, using the declarative role/permission guard mechanism this repo already provides
  (established in the User Login Backend & Access Control feature), not only by hiding UI elements.
- **FR-012**: The system MUST re-evaluate a user's current role and its current permissions on that
  user's next authenticated request after either is changed, without waiting for their session to
  expire naturally.
- **FR-013**: The system MUST provide a list of existing user accounts (name, email, role, status
  — including `pending`, `inviteExpiresAt` when applicable — last-login timestamp) scoped to the
  requesting admin's company, except for a cross-company Super Admin.
- **FR-014**: The system MUST allow a Super Admin or HO User to edit an existing user account's
  assigned role or active/inactive status, and MUST reject the same operation from any other role.
  A direct write of `status: 'active'` against a currently-`pending` account MUST be rejected with
  `400` — that transition only happens via `010-account-creation-backend`'s set-password flow.
- **FR-015**: The system MUST allow a Super Admin or HO User to delete an existing user account,
  after which it can no longer authenticate and no longer counts toward any role's assigned-user
  count.
- **FR-016**: The system MUST NOT allow the last remaining active Super Admin account to be
  deactivated, deleted, or reassigned to a different role.
- **FR-017**: The system MUST update a user account's last-login timestamp on every successful
  authentication.
- **FR-018**: The system MUST provide per-company CRUD for Department and Designation reference
  data, each scoped strictly to the company that owns it, and MUST reject deletion of one still
  referenced by an Employee record.
- **FR-019**: The system MUST provide per-company CRUD for Document Types, each with independently
  toggled Mandatory, Has Expiry Date, and Needs Document Number flags plus a numeric Sort Order and
  Active flag, and MUST compute a derived display flag (MandatoryNumber, Mandatory, ExpiryNumber,
  Expiry, Number, or Optional) deterministically from those toggles.
- **FR-020**: The system MUST seed every newly created company with the documented set of default
  document types and their default flags, editable thereafter by an admin.
- **FR-021**: The system MUST prevent attendance from being marked for an employee who is missing
  one or more document types flagged Mandatory for their company.
- **FR-022**: The system MUST provide per-company CRUD for Shifts (name, in-time, out-time, grace
  period in minutes), scoped strictly to the company that owns it, and MUST reject deletion of one
  still referenced by an Employee record.
- **FR-023**: The system MUST generate each new employee's code as `{CompanyShortCode}-
  {SequentialNumber}` (zero-padded to 4 digits, e.g., DC-0001), with the sequence maintained
  per-company and guaranteed free of duplicates or gaps under concurrent generation requests.
- **FR-024**: The system MUST continue an existing company's employee-code sequence unchanged
  (only the short-code prefix updates) if that company's short code is edited after codes have
  already been generated.
- **FR-025**: The system MUST log every create, edit, and delete operation on Companies, Roles, and
  Employee Setup reference data (Departments, Designations, Document Types, Shifts) to the audit
  log, capturing the acting admin's identity, timestamp, company, and the nature of the change.
- **FR-026**: Every endpoint in this feature MUST accept and return validated, typed request/
  response structures that reject unexpected fields, consistent with this repo's existing DTO
  contract pattern.
- **FR-027**: Every company-scoped table this feature introduces (Companies, Roles, Users' role
  assignment, Departments, Designations, Document Types, Shifts, employee code sequence state) MUST
  carry a company identifier where applicable and MUST be protected so a query can never return or
  modify another company's data, except through the single, already-established Super Admin
  cross-company exception.

### Key Entities

- **Company**: One legal entity within the group — carries identity (name, unique short code,
  logo, active status), registration numbers, address, statutory codes, and payroll contribution
  settings. The root scope every other company-scoped entity in this feature (and across the wider
  system) is filtered by.
- **Role**: A named, admin-manageable set of permissions drawn from the system's fixed permission
  identifier set. Nine default roles are shipped; Super Admin is immutable and undeletable, all
  others are fully editable/deletable. Tracks how many user accounts currently hold it.
- **User Account (administration view)**: The same account entity owned by the separate Account
  Creation feature; this feature reads, lists, edits (role/status), and deletes it, but does not
  create it.
- **Department / Designation**: Simple per-company named reference entries that populate Employee
  form dropdowns; cannot be deleted while an Employee record references them.
- **Document Type**: A per-company reference entry with Mandatory/Has-Expiry/Needs-Number toggles,
  a derived display flag, sort order, and active flag; mandatory ones gate attendance marking for
  employees missing them.
- **Shift**: A per-company reference entry (name, in-time, out-time, grace period) used for Employee
  form selection and downstream overtime calculation; cannot be deleted while an Employee record
  references it.
- **Employee Code Sequence**: Per-company counter state driving auto-generated employee codes in
  the `{ShortCode}-{SequentialNumber}` format; survives a company's short-code change without
  renumbering already-issued codes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A Super Admin can fully configure a new company (all tabs) and have it selectable
  elsewhere in the system in under 5 minutes.
- **SC-002**: Across all testing, zero requests to a permission-restricted endpoint succeed for an
  account whose current role lacks the required permission, verified independent of any UI state.
- **SC-003**: Across all testing, zero queries scoped to one company ever return or modify another
  company's data, except through the single, already-established Super Admin cross-company
  exception.
- **SC-004**: An admin can create a new user's appropriate role assignment or status change in
  under 5 minutes from opening the Users list.
- **SC-005**: 100% of newly created companies are seeded with the complete default document-type
  set and their correct derived flags.
- **SC-006**: Across all testing, zero attendance-marking attempts succeed for an employee missing
  a document type flagged Mandatory for their company.
- **SC-007**: Across 1,000 simulated concurrent employee-code generation requests for the same
  company, 100% of generated codes are unique and sequential with no gaps attributable to the
  concurrency itself.
- **SC-008**: Across all testing, the last remaining active Super Admin account can never be
  deactivated, deleted, or have its role reassigned away, and the Super Admin role itself can never
  be renamed, weakened, or deleted.
- **SC-009**: Every create/edit/delete operation on Companies, Roles, and Employee Setup reference
  data is present in the audit log with the correct acting admin, timestamp, and company,
  verifiable by direct inspection.

## Assumptions

- Account *creation* is out of scope for this feature — it belongs to the separate Account Creation
  flow referenced by the PRD (part of the Authentication & Account Management PRD family, alongside
  this repo's own User Login Backend feature). This feature covers listing, editing (role/status),
  and deleting user accounts that already exist.
- The declarative role/permission guard mechanism this feature relies on for server-side enforcement
  (FR-011) is the one already specified/built in this repo's User Login Backend & Access Control
  feature (FR-010 there); this feature supplies the dynamic Roles data that mechanism reads, not a
  second enforcement mechanism.
- Employee Setup reference-data masters (Departments, Designations, Document Types, Shifts) are
  scoped per-company, per clarification, consistent with Code Series already being explicitly
  company-wise in the PRD and with this repo's strict multi-tenancy NFR.
- Role permissions are drawn from a fixed, system-defined enumerated set rather than freeform text,
  per clarification, so server-side RBAC checks can validate against known values instead of
  pattern-matching arbitrary strings.
- The Super Admin role is protected/immutable (cannot be renamed, weakened, or deleted) and the
  last remaining active Super Admin account cannot be deactivated, deleted, or reassigned away, per
  clarification — a system-enforced safeguard against total lockout, extending beyond what the PRD
  states explicitly.
- "Site Supervisor" (mentioned in the PRD as a functional responsibility rather than a distinct
  role) requires no dedicated entity or endpoint in this feature — it is fully expressed by whichever
  existing role holds the Daily Worker Registry permission, which is itself just one value in the
  fixed permission set (FR-007).
- The Employees module (and its "Setup" entry point) is assumed to exist as a separate feature that
  consumes this feature's reference-data endpoints; this feature is responsible for the reference
  data itself, not the Employee record CRUD or its own attendance-marking logic beyond the gating
  check described in FR-021.
- Logo Upload (Company Basic Info tab) is assumed to reuse whatever file-storage mechanism the
  broader system adopts for document/file uploads generally; this feature does not define a new
  storage mechanism, only the field that references an uploaded file.
