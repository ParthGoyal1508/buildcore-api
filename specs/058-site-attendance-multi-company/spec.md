# Feature Specification: Refusals for Super Admin, site-tagged staff attendance, multi-company access

**Feature Branch**: `058-site-attendance-multi-company`

**Created**: 2026-11-06

**Status**: Draft

**Input**: User description: "We want to show Refusals of attendance only to Super admin. Also can we have multiple sites in a project and attendance can be tagged to a site instead of Project? For a project we might have multiple locations where workings are there." Plus the client's roles sheet (`docs/Roles and Permissions.xlsx`), which sets "Both companies" for roles that are not Super Admin.

**Decisions taken with the user (2026-11-06)**:

- Refusal logs (staff and labour) are for Super Admin only. An employee still sees the reason for **their own** refused punch, both at the moment it is refused and in their own list of refused attempts.
- Staff attendance is tagged to the site where the punch happened, and one employee may work at several sites (including several sites of one project). The existing "mobile" option stays.
- "Both companies" for roles that are not Super Admin is built as its own capability: the person switches between companies and gets only their role's modules, with none of Super Admin's group-level powers. Making them Super Admin, or giving them two logins, was rejected.
- "Super Admin" means the cross-company permission, never the role's display name (the existing rule in this codebase).

**Terms**:

- **All-companies role**: a role with "Works in all companies" ticked (UI label). Its holders are
  called multi-company users.
- **"Both companies"**: used only when quoting the client's sheet.
- **Super Admin**: the cross-company permission.

## Clarifications

### Session 2026-11-06

- Q: Is both-company access set on the role or on each person? → A: On the role, as the client sheet does it. Everyone holding the role gets it, and there is no per-person setting.
- Q: Should the monthly attendance sheet and payroll split an employee's days by punch site? → A: No. They stay grouped by the employee's home site. The punch site shows in the daily register, the employee's attendance views and exports.
- Q: Who may give a user a role marked "all companies", or take it away? → A: Only Super Admin. Single-company user admins can still assign every other role.

### Session 2026-11-07 (added scope: US4, US5)

- Q: What may a site supervisor do in labour? → A: Only register labour, mark attendance (face punch and the group photo), and see the attendance list for their sites. Everything else (muster attendance, payment sheets, musters, advances, supervisor allocation, rates, and editing, transferring or deactivating a registered labour) is the Operations Manager's.
- Q: Can a supervisor correct a registered labour's details? → A: No. The Operations Manager does it. A supervisor may still add photos (face enrolment) for a labour registered without them.
- Q: Who uploads the group photo? → A: The site supervisor. Viewing past group photos stays with the Operations Manager.
- Q: What happens to existing roles that hold the labour permission? → A: Only the role named "Labour Supervisor" moves to the new narrow permission. Roles that also hold labour approvals keep full labour management.
- Q: How many module-specific roles? → A: Two per module, View and Edit. A permission with no levels (an approval, HR letters, export) gets one role.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Only Super Admin sees attendance refusals (Priority: P1)

A refused punch carries where a named person was, their photo and how well their face matched. The
client wants that seen only by the directors (Super Admin). Today any HR user who can edit
attendance sees the staff refusal log with photos, and any labour approver sees the labour refusals
of a site.

**Why this priority**: it is a privacy restriction the client asked for, it is small, and nothing
else depends on it.

**Independent Test**: sign in as an HR user who can edit attendance, and as a labour approver. Neither
sees a Refusals tab or list, and asking the server directly for refusals or a refusal photo is
refused. Sign in as Super Admin: both logs and photos are visible as before. Sign in as an employee
whose punch was refused: they still see their own reason and their own list.

**Acceptance Scenarios**:

1. **Given** a user with attendance edit rights who is not Super Admin, **When** they open the
   attendance workspace, **Then** no Refusals tab is shown, and a direct request for the staff
   refusal log or a refusal photo is refused as forbidden.
2. **Given** a labour approver who is not Super Admin, **When** they open labour attendance for a
   site, **Then** no refused-punch list is shown, and a direct request for site refusals or a
   refusal photo is refused as forbidden.
3. **Given** a Super Admin, **When** they open either screen, **Then** the refusal logs and photos
   are shown exactly as today.
4. **Given** an employee whose own punch is refused, **When** the punch fails and later when they
   open their refused attempts, **Then** they see the reason as today.
5. **Given** a multi-company user from User Story 3, **When** they open either screen, **Then**
   they are treated as not Super Admin and see no refusals.

---

### User Story 2 - Staff punch at any of their assigned sites, tagged to that site (Priority: P1)

A project often has several working locations, each its own site with its own geofence. An engineer
may move between them during the week, or between sites of different projects. Today an employee's
punch is checked against one site only, so a punch at the project's other location is refused (or
the employee has to be made "mobile", which drops the location check altogether), and the punch does
not record where it was made.

HR assigns the employee to the sites they work at: specific sites, or a whole project, meaning every
active site of that project. A punch inside any of those geofences is accepted and records the site
it was made at. The attendance register, the employee's history and the reports show that site.

**Why this priority**: it is the user's main request and it fixes real refusals at multi-location
projects.

**Independent Test**: give a project two sites far apart. Assign an employee to that project. A
punch inside either fence is accepted and shows that site in the register. A punch outside both is
refused as outside the geofence. An employee assigned to one site only behaves exactly as today.

**Acceptance Scenarios**:

1. **Given** an employee assigned to sites A and B, **When** they punch inside A's fence, **Then**
   the punch is accepted and recorded against site A.
2. **Given** the same employee, **When** they punch in at A and punch out at B, **Then** both punches
   are accepted and each records its own site.
3. **Given** an employee assigned to project P, **When** a new active site is added to P later,
   **Then** punches inside the new site's fence are accepted without changing the assignment.
4. **Given** an employee assigned to sites A and B whose fences overlap, **When** they punch in the
   overlap, **Then** the punch is recorded against the site whose centre is nearest.
5. **Given** an employee assigned to sites A and B, **When** they punch outside both fences, **Then**
   the punch is refused (or flagged, while the hard block is off) as outside the geofence, and the
   distance to the nearest assigned site is kept as evidence.
6. **Given** a mobile employee, **When** they punch anywhere, **Then** the punch is accepted as
   today and recorded against no site.
7. **Given** an employee with no assignment, **When** they punch, **Then** their own site is used as
   today, and the punch is recorded against it.
8. **Given** HR opening the daily attendance register or an employee's attendance, **When** punches
   exist, **Then** the site of each punch in and punch out is shown, and the register can be
   filtered by site.

---

### User Story 3 - Work in both companies without Super Admin powers (Priority: P2)

The client's roles sheet gives Operations Manager, Billing Engineer, Plant & Machinery Incharge,
Purchase Manager and Cashier access to both companies. Today the only way to do that is the
cross-company permission, which also gives everything a director has: data from all companies at
once, App Settings, the group dashboard, every company's settings and numbering, user
administration across companies, all-company reminders, self-approval of DWRs, and (after User
Story 1) refusals.

A Super Admin can now mark a role as working in all companies of the group. A person holding such a
role chooses which company they are working in, the same way a Super Admin does today, and sees and
changes only that company's data, through only the modules their roles allow.

**Why this priority**: it blocks setting up the client's roles sheet as written, but the roles can be
set up company-by-company in the meantime.

**Independent Test**: mark a role "all companies", give it Inventory only, and assign it to a user
whose home company is PRPL. The user can switch to TE and back and sees only that company's
inventory each time. They cannot open App Settings, the group dashboard, another company's settings,
user administration, all-company reminders or refusals, and cannot self-approve a DWR.

**Acceptance Scenarios**:

1. **Given** a user whose role works in all companies, **When** they sign in, **Then** they work in
   their home company and the company switcher is offered to them.
2. **Given** that user, **When** they switch company, **Then** every list, report, export, creation
   and approval reflects only the selected company until they switch again.
3. **Given** that user, **When** no company is explicitly selected, **Then** they work in their home
   company. They never see several companies' data at once.
4. **Given** that user, **When** they try to reach App Settings, the group dashboard, another
   company's company settings, cross-company user administration, all-company reminders or the
   refusal logs, **Then** each is refused as it is for a single-company user.
5. **Given** that user submitting a DWR, **When** they try to approve their own DWR, **Then** it is
   refused as for any user who is not Super Admin.
6. **Given** a Super Admin editing roles, **When** they mark or unmark a role as "all companies",
   **Then** the change is recorded in the audit log, and the role's holders gain or lose the switcher
   from their next request. A holder who loses it goes back to their home company.
7. **Given** a user who is not Super Admin, **When** they manage roles or users (if they hold that
   permission), **Then** they cannot set "all companies" on a role, and cannot give a user, or take
   from a user, a role that has it.
8. **Given** a Super Admin, **When** anything in this story ships, **Then** their own behaviour is
   unchanged.

---

### User Story 4 - Site supervisors only register labour and mark attendance (Priority: P1)

Today the one labour permission a site supervisor holds also lets them create payment sheets and
advances, see musters and muster attendance, change wage rates, and transfer or deactivate labour.
The client wants the supervisor limited to registering labour and marking attendance at their sites;
the Operations Manager does the rest.

**Independent Test**: a user holding only "Labour registration & attendance", assigned to site S,
sees the Attendance and Labour tabs only. They can register a labour at S, add photos, punch them in
and out, and upload a group photo. Payment sheets, advances, musters, muster attendance, rates,
supervisor allocation, and edit, transfer or deactivate are all refused, by the server and the
screens. An Operations Manager holding labour management and approvals keeps everything.

**Acceptance Scenarios**:

1. **Given** a supervisor with the new permission, **When** they open Labour, **Then** only
   Attendance and Labour are offered, and the labour list shows no Edit, Transfer, Deactivate or
   NOC.
2. **Given** the same supervisor, **When** they call any other labour endpoint, **Then** it is
   refused (403).
3. **Given** an Operations Manager, **When** they allocate supervisors to sites, **Then** holders
   of the new permission are listed alongside today's supervisors.
4. **Given** the existing "Labour Supervisor" role, **When** the release is applied, **Then** it
   holds the new permission instead of the old one, and roles that also hold labour approvals are
   unchanged.

### User Story 5 - Module-specific roles ready to grant (Priority: P3)

For each module there is a ready-made "<Module> — View" role and a "<Module> — Edit" role, and one
role for each single-ability permission (approvals, HR letters, export). A Super Admin can give
someone a module's access by adding a role, without building one first.

**Independent Test**: after the setup script runs, Settings → Roles lists the module roles. Each
View role grants only read on its area, each Edit role read and write, and running the script again
changes nothing.

### Edge Cases

- An assignment naming a site that is later deactivated: punches there are no longer accepted. The
  other assigned sites still work.
- An assignment to a project with no active sites: every punch is refused as outside the geofence,
  and HR sees a warning when saving the assignment.
- An assignment that mixes sites of another company: refused when saving.
- Sites must belong to the employee's company, and a project must too. An employee cannot be assigned
  to a site of the other company even when the HR user can work in both companies.
- Punches made before this feature have no recorded site. Where the site can be known from the
  single site the punch was checked against and it was accepted in range, it is filled in. Otherwise
  it shows as blank.
- Manual punches and corrections entered by HR: HR may choose the site from the employee's assigned
  sites. When there is exactly one, it is used automatically. Otherwise it is optional and may stay
  blank.
- Offline punches synced later use the location captured at the time of the punch, as today.
- A user holding two roles where only one is "all companies" gets the switcher. Their module rights
  are still the union of both roles in whichever company they select.
- A multi-company user whose home company is deactivated: they work in the first remaining company
  they can reach.
- Approval chains: a multi-company user acts as an approver only in the selected company, with that
  company's chains.
- Cash hiding: a multi-company user sees cash according to the selected company's setting, like any
  other user in that company.
- A multi-company user's own employee record lives in their home company. My Workspace (own punch,
  leave, salary slips, claims, loans, profile) MUST keep working on that record whichever company
  they have selected.

## Requirements *(mandatory)*

### Functional Requirements

**Refusal visibility (User Story 1)**

- **FR-001**: The staff refusal log and its photos MUST be available only to Super Admin.
- **FR-002**: The labour site refusal list and its photos MUST be available only to Super Admin.
- **FR-003**: Screens MUST NOT show refusal tabs, lists, counts or links to anyone else.
- **FR-004**: An employee's own refusal reason, at punch time and in their own refused-attempts list,
  MUST remain visible to that employee. The same applies to the message a labour supervisor sees
  when a worker's punch is refused at that moment.
- **FR-005**: Refusals MUST still be recorded for everyone, exactly as today. Only who can see them
  changes.

**Site-tagged staff attendance (User Story 2)**

- **FR-006**: A staff location assignment MUST be able to cover one or more sites, one or more
  projects (meaning all active sites of each project at punch time), or be mobile. Mobile excludes
  the other two.
- **FR-007**: A punch MUST be accepted when it falls inside the geofence of any site covered by the
  assignment in force on the punch day. Otherwise it is outside the geofence, judged by the existing
  rules: hard block, accuracy allowance and unlocatable handling.
- **FR-008**: Each accepted staff punch MUST record the site it was matched to. When more than one
  fence contains the punch, the nearest site centre wins.
- **FR-009**: For a refused or flagged punch, the evidence MUST record the nearest covered site and
  the distance to it.
- **FR-010**: An employee with no assignment, or with a single-site assignment, MUST behave exactly as
  today, apart from the site now being recorded.
- **FR-011**: The daily attendance register, an employee's attendance view, the employee's own
  history and attendance exports MUST show the site of the punch in and of the punch out. The
  register MUST be filterable by site.
- **FR-012**: HR manual punch entry and attendance corrections MUST let HR choose the site from the
  employee's covered sites (any active company site for a mobile employee). The site is optional.
  When it is omitted and exactly one site is covered, that site is used.
- **FR-013**: Saving an assignment MUST reject sites or projects of another company, and MUST warn
  when a project has no active site.
- **FR-014**: Changing an assignment MUST keep its effective-from date and history, as today, and
  MUST now also write an audit log entry naming the employee, the targets and who assigned them.
- **FR-015**: Existing punches MUST get a site where it can be determined safely (accepted in range
  against a single known site). Otherwise they stay blank.
- **FR-016**: Payroll day counts and hours MUST NOT change because of this feature. The monthly
  attendance sheet and payroll MUST keep grouping staff by their home site. The punch site is shown
  only in the daily views and exports named in FR-011.

**Multi-company access (User Story 3)**

- **FR-017**: A role MUST be able to be marked "works in all companies". Only Super Admin may set or
  clear it, and every change MUST be audited.
- **FR-017a**: Only Super Admin MAY assign a role marked "all companies" to a user, or remove it.
  A user admin who is not Super Admin MUST be refused, but can still assign any other role. Each
  assignment and removal is audited.
- **FR-018**: A user holding such a role MUST be able to choose the company they work in, from all
  active companies of the group. They default to their home company.
- **FR-019**: Every data access by such a user MUST be scoped to exactly one company: the selected
  one, or else the home company. Database tenant isolation MUST hold for them exactly as for a
  single-company user.
- **FR-020**: Such a user MUST receive none of Super Admin's group powers: viewing all companies at
  once, App Settings and the cash switch, the group dashboard, other companies' company settings,
  creating companies, cross-company user administration, all-company reminders, DWR self-approval
  and refusal logs.
- **FR-021**: Their module permissions MUST be exactly the union of their roles' permissions,
  applied in the selected company.
- **FR-022**: The screens MUST show the company switcher to such users. Group-only screens MUST stay
  hidden from them.
- **FR-023**: Super Admin's behaviour MUST be unchanged.
- **FR-024**: After this ships, the roles in the client sheet (Operations Manager, Billing Engineer,
  Plant and Machinery Incharge, Site Supervisor, HR Manager, Purchase Manager, Cashier) MUST be
  settable with their ticked modules and company access, without granting Super Admin.

**Labour split (User Story 4)**

- **FR-025**: There MUST be a permission "Labour registration & attendance" that allows exactly: the
  caller's own sites list, the labour list and a labour's details, registering a labour (with its
  contractor options), adding a labour's face photos, today's attendance list, the face punch, and
  uploading the group photo — at the caller's assigned sites only, as today.
- **FR-026**: Every other labour action MUST require "Labour management" (today's Daily Worker
  Registry, renamed in the screens) or "Labour approvals", unchanged: muster attendance, payment
  sheets, musters, advances, wage and site rates, supervisor allocation, gangs, and editing,
  transferring or deactivating a labour.
- **FR-027**: Supervisor allocation MUST list holders of either labour permission.
- **FR-028**: The screens MUST offer a holder of only the new permission just the Attendance and
  Labour tabs, and no Edit, Transfer, Deactivate or NOC on the labour list.
- **FR-029**: The release MUST move the role named "Labour Supervisor" from Daily Worker Registry to
  the new permission (same levels), and change no other role.

**Module roles (User Story 5)**

- **FR-030**: An idempotent setup script MUST create, as roles shared by every company: for each
  levelled permission (except Cross-company access) a "<Module> — View" role (read) and a
  "<Module> — Edit" role (read and write), and for each permission without levels a single
  "<Ability>" role. It MUST NOT change or delete existing roles, and MUST leave a role it created
  earlier as it is.

### Key Entities

- **Staff location assignment**: from an effective date, where an employee may punch. It is mobile,
  or covers a set of sites and/or projects. It replaces "one site or mobile".
- **Staff punch**: gains the site it was matched to (blank for mobile and for old punches that can't
  be resolved).
- **Refused punch**: gains the nearest covered site (it already keeps the distance).
- **Role**: gains "works in all companies".
- **Company selection**: today it is only for Super Admin. It is now also for holders of an
  all-companies role.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No user who is not Super Admin can view any staff or labour refusal or refusal photo,
  checked for each existing role.
- **SC-002**: An employee assigned to a project with several sites can punch successfully at every
  one of those sites, with no change to the assignment between sites.
- **SC-003**: 100% of punches made by employees and accepted after release show the site they were made at, except
  for mobile employees.
- **SC-004**: HR can answer "who punched at site X on day D" from the register in one filter.
- **SC-005**: A user with an all-companies role can switch company and complete their normal tasks in
  both companies, and is refused 100% of the Super-Admin-only actions listed in FR-020.
- **SC-006**: Super Admin's existing workflows and payroll results are identical before and after
  release.

## Assumptions

- "Both companies" in the sheet means all active companies of the group (today PRPL and TE). It is
  set per role only (confirmed 2026-11-06). Someone who needs one company only holds a role without
  the flag.
- A multi-company user acts in one company at a time, like a Super Admin with a company selected.
  There is no combined view for them.
- An assignment to a project means all of the project's active sites at the moment of each punch, so
  sites added later are included automatically.
- Labour attendance is unchanged. It is already tagged per site through supervisor site assignments.
- The roles sheet's follow-ups (HR Manager company access blank, Billing Engineer's recruitment
  ticks, export/delete not yet enforced, Purchase Manager's sites, the empty Approvals sheet, and
  existing roles not in the sheet) are for the client and are out of scope here.
- Setting up the actual roles from the sheet is a data step after release, not part of the code.
