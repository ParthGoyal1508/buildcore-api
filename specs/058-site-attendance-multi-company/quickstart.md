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
