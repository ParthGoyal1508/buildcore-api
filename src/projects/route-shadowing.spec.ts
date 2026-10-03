import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';

import { ProjectsModule } from './projects.module';

/**
 * No literal route under `projects/` may be registered behind a parameterised one that swallows it.
 *
 * ## The defect this exists for
 *
 * `BoqController` is mounted at `projects/:id/boq` and `ClientBillsController` serves the billing
 * sheet's priced schedule at `projects/client-bills/boq`. Express matches in registration order, and
 * `projects/:id/boq` matches `projects/client-bills/boq` with `id` bound to the literal string
 * `client-bills`. Registered first — as it was on 2026-10-03 — it answered the billing sheet with the
 * BOQ tree of a project that does not exist: **HTTP 200 carrying an empty array.** Every project in
 * the company would have reported having no BOQ, on a screen whose entire job is to show one.
 *
 * Nothing announces this. There is no error, no warning at boot, and no failing unit test: both
 * controllers are correct in isolation and the collision lives in the order of one array. It was
 * found by the first end-to-end run of the billing path, and the module comment that *should* have
 * caught it asserted the opposite — that the paths "cannot collide".
 *
 * ## Why this is reflection rather than a booted application
 *
 * Reading Nest's own route metadata needs no database and no HTTP server, so this runs in the unit
 * suite where a developer sees it within seconds of adding a controller — rather than in the e2e
 * suite, which needs a database and is where this defect sat waiting for somebody to write the test
 * that found it.
 */

/** One registered route, in the order Nest will hand it to Express. */
interface Route {
  controller: string;
  handler: string;
  /** `GET`, `POST`, … */
  method: string;
  /** Normalised, no leading or trailing slash. */
  path: string;
}

const METHOD_NAMES = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'ALL',
  'OPTIONS',
  'HEAD',
  'SEARCH',
];

const trim = (path: string) => path.replace(/^\/+|\/+$/g, '');

function routesOf(module: unknown): Route[] {
  const controllers =
    (Reflect.getMetadata('controllers', module as object) as unknown[]) ?? [];
  const routes: Route[] = [];

  for (const controller of controllers) {
    const type = controller as new (...args: never[]) => unknown;
    const prefix = trim(String(Reflect.getMetadata(PATH_METADATA, type) ?? ''));
    const proto = type.prototype as object;

    for (const handler of Object.getOwnPropertyNames(proto)) {
      if (handler === 'constructor') continue;
      // On the method **function**, not on the prototype under a property key. `@Get()` calls
      // `Reflect.defineMetadata(PATH_METADATA, path, descriptor.value)`, and reading it the other
      // way returns undefined for every handler — which produced an empty route list and would
      // have made the sweep below pass by finding nothing. The vacuity case above caught it.
      const target = (proto as Record<string, unknown>)[handler];
      if (typeof target !== 'function') continue;
      const own = Reflect.getMetadata(PATH_METADATA, target) as
        | string
        | undefined;
      if (own === undefined) continue;

      const verb = Reflect.getMetadata(METHOD_METADATA, target) as
        | number
        | undefined;
      const suffix = trim(own === '/' ? '' : own);
      routes.push({
        controller: type.name,
        handler,
        method: METHOD_NAMES[verb ?? 0] ?? String(verb),
        path: [prefix, suffix].filter(Boolean).join('/'),
      });
    }
  }
  return routes;
}

/**
 * Whether `earlier` will answer every request `later` was written for.
 *
 * Segment by segment, same length: a request reaches `later` only if some segment of `earlier`
 * refuses it. A parameterised segment refuses nothing, so a literal sitting under one is dead.
 * Two params in the same position are not a conflict — they are the same route shape, and a
 * genuinely duplicated path would be caught by Nest itself.
 */
function shadows(earlier: Route, later: Route): boolean {
  if (earlier.method !== later.method && earlier.method !== 'ALL') return false;

  const a = earlier.path.split('/');
  const b = later.path.split('/');
  if (a.length !== b.length) return false;

  let swallowsALiteral = false;
  for (let i = 0; i < a.length; i += 1) {
    const mine = a[i];
    const theirs = b[i];
    if (mine.startsWith(':') || mine === '*') {
      // A wildcard here is only a problem if the route behind it is more specific.
      if (!theirs.startsWith(':') && theirs !== '*') swallowsALiteral = true;
      continue;
    }
    if (mine !== theirs) return false;
  }
  return swallowsALiteral;
}

describe('ProjectsModule route registration order', () => {
  const routes = routesOf(ProjectsModule);

  it('reads the module’s routes at all — a silent zero would make every assertion below vacuous', () => {
    // The check that separates "no shadowing" from "no routes were found", which look identical
    // from the outside. `boq-workbook.reader.spec.ts` learned this lesson the hard way the same day.
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.map((route) => route.path)).toContain(
      'projects/client-bills/boq',
    );
    expect(routes.map((route) => route.path)).toContain('projects/:id/boq');
  });

  it('registers no literal path behind a parameterised one that would swallow it', () => {
    const shadowed: string[] = [];
    for (let later = 0; later < routes.length; later += 1) {
      for (let earlier = 0; earlier < later; earlier += 1) {
        if (shadows(routes[earlier], routes[later])) {
          shadowed.push(
            `${routes[later].method} ${routes[later].path} ` +
              `(${routes[later].controller}.${routes[later].handler}) is answered by ` +
              `${routes[earlier].method} ${routes[earlier].path} ` +
              `(${routes[earlier].controller}.${routes[earlier].handler})`,
          );
        }
      }
    }

    // Named, not counted. "One route is shadowed" sends somebody through four hundred registrations;
    // the pair is the whole of the fix.
    expect(shadowed).toEqual([]);
  });

  it('puts the billing sheet’s priced schedule ahead of the BOQ tree, specifically', () => {
    // Stated as its own case as well as being covered by the sweep above, because this is the pair
    // that actually broke and a regression here is worth a test that names it.
    const schedule = routes.findIndex(
      (route) =>
        route.path === 'projects/client-bills/boq' && route.method === 'GET',
    );
    const tree = routes.findIndex(
      (route) => route.path === 'projects/:id/boq' && route.method === 'GET',
    );

    expect(schedule).toBeGreaterThanOrEqual(0);
    expect(tree).toBeGreaterThanOrEqual(0);
    expect(schedule).toBeLessThan(tree);
  });
});
