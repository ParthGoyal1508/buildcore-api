# Quickstart: validating 058

## Prerequisites

- Both worktrees are on `058-site-attendance-multi-company`. The API runs against a scratch or e2e
  database (`npm run migrate:dev` in buildcore-api-058); the web runs with `npm run dev` in
  buildcore-web-058.
- **Never run against prod.** Dev (Neon) is shared with the user's testing, so only touch it after
  merge.
- **Logins**: a Super Admin; an HR user with ATTENDANCE write; a labour approver; an employee login
  linked to an employee (on dev: sudhir.mittal → TE-0077).

## Automated

```sh
cd buildcore-api-058 && npm run lint && npm test && npm run test:e2e
cd buildcore-web-058 && npm run lint && npm run typecheck   # web has no unit test runner; screens are checked by hand (below)
```

The new specs cover:

- Refusal route guards: Super Admin 200; HR and labour approver 403; `/my/punch/refusals` 200.
- Matching across several sites: in A, in B, in the overlap (nearest wins), outside both (nearest
  recorded), mobile, no assignment, every site inactive.
- Assignment validation: empty, mobile with targets, a site of the other company, a project with no
  active site (warning).
- The backfill migration, on fixture rows.
- Multi-company:
  - The swap scopes lists and creates to the selected company.
  - Group routes return 403.
  - `my/*` reads the home employee.
  - The decorator coverage test lists every `my/*` controller.
  - Roles and users refuse `allCompanies` from callers who aren't Super Admin.
- Super Admin regression: selection and bypass are unchanged.

## Manual scenarios

1. **Refusals (US1)**:
   - As HR with attendance edit rights: Attendance has no Refusals tab, and
     `GET /hr/attendance/refusals` returns 403.
   - As a labour approver: labour attendance shows no refused list.
   - As Super Admin: both are visible.
   - As the employee: a refused punch still shows its reason, and My refused attempts lists it.
2. **Several sites (US2)**:
   - Create project P with sites A and B, far apart, plus a site C outside it. Assign the employee
     to project P.
   - Punch at A's coordinates: accepted, and the register shows A.
   - Punch out at B: accepted, and the register shows B in the out column.
   - Punch at C: refused as outside the geofence, with the evidence naming the nearest of A or B.
   - Add site D to P and punch there: accepted.
   - Filter the register by B: only that employee's day shows.
   - The monthly attendance sheet and payroll totals are unchanged.
3. **Multi-company (US3)**:
   - As Super Admin, mark "Operations Manager" as all companies, then assign it to a PRPL user.
   - Log in as that user: the switcher shows PRPL and TE. Switch to TE: inventory lists TE only, and
     creating an item creates it in TE.
   - Group dashboard, App Settings, another company's settings and the refusals all return 403.
   - My Workspace punch and salary slips still show the user's own PRPL record while TE is selected.
   - As a PRPL user admin who isn't Super Admin: assigning that role returns 403.
   - Unmark the role: the user's next request works in PRPL only, and the switcher disappears.

## Added 2026-11-07

4. **Labour split (US4)**: as a user holding only "Labour Registration & Attendance" and assigned
   to a site, Labour shows Attendance and Labour only. Registering a labour, adding photos,
   punching and the group photo all work. Payment sheets, advances, musters, muster attendance,
   rates and supervisors show an access message (the API answers 403), and the labour list has no
   Edit, Transfer, Deactivate or NOC. An Operations Manager holding Labour Management and Labour
   Approvals sees everything. e2e: `test/labour-supervisor-scope.e2e-spec.ts`.
5. **Module roles (US5)**: `npm run roles:modules` on the local DB creates the "<Module> — View" /
   "<Module> — Edit" roles and the single-ability roles. Running it again creates none. A remote
   database needs `-- --host <host>`.

## Added 2026-11-07 (client answers to the roles sheet)

6. **Delete is Super Admin only**: as any user without Super Admin, Delete, Discard and Remove are
   gone from whole records (purchases, issues, projects, bills, masters, users, roles…), and
   `DELETE` on such a route answers 403 `DELETE_SUPER_ADMIN_ONLY`. The following still work for
   whoever may edit:
   - removing a BOQ line, a draft bill's extra item, a photo, an attachment or a document;
   - the person's own draft claim.
   `record-delete.coverage.spec.ts` lists the routes that stay open.
7. **Purchase Manager at every store**: a user with Inventory "Add & edit" and site delivery
   entry can pick any active site of the company they work in. A Site Incharge without Inventory
   editing still sees only their assigned sites.
8. **Approvals**:
   - A leave, claim, loan, salary advance or attendance exception waits for the Operations
     Manager, then the Director.
   - An attendance correction, labour advance or fuel recovery waits for the Director only.
9. **Roles sheet**: `npm run roles:client` prints what it would do. `APPLY=1` writes. A remote
   database needs `-- --host <host>`. A second run reports nothing to do.
