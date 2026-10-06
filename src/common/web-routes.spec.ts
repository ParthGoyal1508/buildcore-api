import { webRoutes } from './web-routes';

/**
 * These are routes in **another repository**, so nothing here can prove the page exists. What this
 * pins is the property that was actually wrong on 2026-10-06, across seven call sites: four hrefs
 * omitted the `/dashboard` prefix every page in buildcore-web sits under, and three named a page
 * that was never built.
 *
 * So the useful assertion is the shared one — every route starts `/dashboard/` — applied to the
 * whole table rather than to the entries somebody remembered to list. `Object.values` is what makes
 * that true of a route added next year.
 */
describe('webRoutes', () => {
  it('puts every route under /dashboard, which is where every page in that app lives', () => {
    for (const [name, build] of Object.entries(webRoutes)) {
      const href = build('x');
      expect([name, href.startsWith('/dashboard/')]).toEqual([name, true]);
    }
  });

  it('builds no route containing an unsubstituted template or a double slash', () => {
    for (const [name, build] of Object.entries(webRoutes)) {
      const href = build('x');
      // `${` surviving into the string means a template literal was quoted by mistake; `//` means
      // an id came through empty and the path silently became its parent.
      expect([name, href.includes('${'), href.includes('//')]).toEqual([
        name,
        false,
        false,
      ]);
    }
  });

  it('points an RA bill at its project tab, not at an API resource path', () => {
    // The reported defect: `/projects/:projectId/ra-bills/:billId` is a route on *this* server.
    expect(webRoutes.projectRaBills('p1')).toBe(
      '/dashboard/projects/portfolio/p1/ra-bills',
    );
  });

  it('separates a project letter from every other letter', () => {
    expect(webRoutes.projectLetters('p1')).toBe(
      '/dashboard/projects/portfolio/p1/letters',
    );
    expect(webRoutes.recruitmentLetters()).toBe(
      '/dashboard/recruitment/letters',
    );
  });

  it('sends a payroll run to the run page, not to a /runs/ segment that does not exist', () => {
    expect(webRoutes.payrollRun('r1')).toBe('/dashboard/hr/payroll/r1');
  });

  it('sends an exit clearance to the employee whose page carries that panel', () => {
    expect(webRoutes.employee('e1')).toBe('/dashboard/hr/employees/e1');
  });

  /**
   * Deliberately bare. The attendance page reads no query parameters, and a query string that looks
   * like it narrows the screen but does not is worse than none — the reader trusts it and concludes
   * the record is missing.
   */
  it('appends nothing to attendance, which filters on no query parameter', () => {
    expect(webRoutes.hrAttendance()).toBe('/dashboard/hr/attendance');
  });

  it('sends a fuel exception to the screen that lists exceptions', () => {
    expect(webRoutes.plantFuel()).toBe('/dashboard/plant/fuel');
  });
});
