/**
 * Where an approval item lives **in buildcore-web**.
 *
 * ## Why this file exists
 *
 * The approval spine holds an opaque reference to the item it governs, so each module supplies the
 * `href` the queue links to. Those hrefs were written inline at seven call sites, and on
 * 2026-10-06 every one of them was found to 404:
 *
 *   * four omitted the `/dashboard` prefix that every page in that app sits under;
 *   * three carried the prefix and named a page that does not exist — `/dashboard/letters/:id`,
 *     `/dashboard/hr/attendance/exceptions/:id`, `/dashboard/hr/payroll/runs/:id`.
 *
 * Nobody noticed because an approval link is clicked by whoever is approving, not by whoever wrote
 * the module, and a 404 reads as "the page has not been built yet" rather than as a typo.
 *
 * ## What this fixes, and what it does not
 *
 * Collecting them here makes the set reviewable and gives the `/dashboard` prefix one place to be
 * right. **It does not make them verifiable.** These are routes in another repository; nothing in
 * this one can prove the page exists, and the accompanying spec can only pin the strings against
 * what was true when they were written. Each entry therefore names the file in buildcore-web that
 * serves it, so the next person has something to check against rather than a URL to trust.
 *
 * The durable fix is the one `buildcore-web`'s search module already made: it ignores the server's
 * `href` and maps the result through its own `ROUTES`, because that constant lives beside the pages
 * and cannot drift from them. `app/lib/api/approvals.ts` explicitly argues the other way — "this
 * application must not maintain a second mapping from entity type to route" — and that argument is
 * what left seven dead links in the queue. It is worth revisiting; it is not this change.
 *
 * ## Not addressable
 *
 * Several items have no page of their own. Each returns the closest destination that actually loads
 * **and shows the item**, never a URL assembled from an id the client cannot route on. An RA bill
 * is listed and readable on its project's Subcontractors tab; an exit clearance is a panel on the
 * employee's own page; a fuel exception is a section of the fuel screen.
 */
export const webRoutes = {
  /**
   * A subcontractor bill, on the tab that lists and expands it.
   *
   * `app/dashboard/projects/portfolio/[id]/ra-bills/page.tsx`. There is no per-bill route — the
   * bill opens in place — so the bill id is deliberately not in the path. It used to be, pointing
   * at `/projects/:projectId/ra-bills/:billId`, which is an API resource path and not a page.
   */
  projectRaBills: (projectId: string): string =>
    `/dashboard/projects/portfolio/${projectId}/ra-bills`,

  /**
   * Letters raised against a project.
   *
   * `app/dashboard/projects/portfolio/[id]/letters/page.tsx`, which lists by
   * `subjectType: 'project'` and `subjectId: <projectId>` — so this is reachable only for a letter
   * whose subject is a project.
   */
  projectLetters: (projectId: string): string =>
    `/dashboard/projects/portfolio/${projectId}/letters`,

  /**
   * Every other letter — an employee's, a candidate's, a vendor's.
   *
   * `app/dashboard/recruitment/letters/page.tsx`. A list rather than the letter itself: no
   * per-letter page exists in either place.
   */
  recruitmentLetters: (): string => '/dashboard/recruitment/letters',

  /** `app/dashboard/hr/employees/[id]/page.tsx`. Exit clearance is a panel on this page. */
  employee: (employeeId: string): string =>
    `/dashboard/hr/employees/${employeeId}`,

  /**
   * `app/dashboard/hr/attendance/page.tsx`.
   *
   * The page reads no query parameters today, so the employee and date are **not** appended: a
   * query string that looks like it narrows the screen and silently does not is worse than none,
   * because the reader trusts it and concludes the record is missing.
   */
  hrAttendance: (): string => '/dashboard/hr/attendance',

  /** `app/dashboard/hr/payroll/[id]/page.tsx` — the run itself, not `/payroll/runs/:id`. */
  payrollRun: (runId: string): string => `/dashboard/hr/payroll/${runId}`,

  /**
   * `app/dashboard/plant/fuel/page.tsx`, which mounts the exceptions list.
   *
   * No per-exception page exists; the exceptions are a section of this screen, and its own comment
   * calls them "the part of this screen somebody has to act on".
   */
  plantFuel: (): string => '/dashboard/plant/fuel',
} as const;
