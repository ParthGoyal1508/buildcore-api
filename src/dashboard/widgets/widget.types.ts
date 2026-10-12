import type { Permission } from '@prisma/client';

import type { DashboardContext } from '../context';

/** The visual grouping the frontend lays a widget out in (data-model.md). */
export type WidgetSection =
  | 'kpi'
  | 'sidebar'
  | 'alerts'
  | 'table'
  | 'group'
  | 'site';

/** How the frontend renders a widget's value (data-model.md). */
export type WidgetDisplayType = 'kpi' | 'table' | 'list' | 'stat';

/**
 * One widget's registration. A provider declares its identity and section, says
 * whether it can be computed at all (`isAvailable`), and — when it can — computes its
 * value. Adding a widget is adding one class carrying this shape and registering it
 * under {@link WIDGET_PROVIDERS}; nothing in `DashboardService` or the response
 * contract changes (spec FR-002, research.md §1).
 */
export interface WidgetProvider {
  id: string;
  displayType: WidgetDisplayType;
  title: string;
  section: WidgetSection;
  /**
   * The permissions that make this widget the caller's business — **any one of them**,
   * the same OR the `@RequirePermissions(...)` decorator uses (2026-10-10).
   *
   * `/dashboard/widgets` is gated on `DASHBOARD`, which every employee holds, and until
   * this existed that was the only gate. So a site engineer's dashboard carried the
   * company's headcount, who was absent today, and a Recent Leaves table naming
   * employees, their leave type and their dates — none of it reachable on any screen
   * they can open. The notification centre had the same hole and was closed first; this
   * is the same fix in the other registry.
   *
   * Declared as the permission the module's own screens are gated on, so a widget and
   * the data behind it cannot drift apart. Omitted where there is nothing to disclose:
   * a placeholder carries no value, only the name of a module not yet built.
   *
   * An array because one widget may legitimately aggregate several modules —
   * `pending-approvals` sums leave, maintenance and reimbursements, and a caller holding
   * any one of the three should see that one's share of it.
   */
  readonly requires?: Permission[];
  /**
   * What the number means, so the interface can format it (2026-10-12).
   *
   * Omitted for a plain count, which renders as itself. `'currency'` marks a rupee
   * amount: the Contract Value card shipped reading `371100000`, which is ₹37.11 crore
   * written in a way nobody can read at a glance and easily mistaken for a different
   * order of magnitude.
   *
   * A declared unit rather than the renderer matching on widget id — `WidgetRenderer`
   * knows no widget's id by design, and a list of "these ids are money" kept on the far
   * side of the wire is a list that goes stale the first time a widget is added.
   */
  readonly valueUnit?: 'currency';
  /**
   * A caveat to print beside the value, when the number is true but incomplete
   * (2026-10-12).
   *
   * Per-request, unlike `valueUnit`, because whether a caveat applies depends on the
   * data: the site fuel cards need one only while the month still contains entries
   * recorded before `FuelEntry.siteId` existed, and it must stop appearing on its own
   * once it does not. A static string would either lie later or have to be removed by
   * hand on a date nobody will remember.
   *
   * Return `undefined` for "nothing to add", which is the normal case and the reason
   * this is optional rather than part of `compute`'s return.
   *
   * The sibling of `unavailable.note`, and the same argument: a card that quietly
   * understates is worse than one that says what it is leaving out.
   */
  note?(ctx: DashboardContext): Promise<string | undefined>;
  /** False for a placeholder standing in for a not-yet-built module (spec FR-003). */
  isAvailable(): boolean;
  /** The module a placeholder is waiting on. Read only when `isAvailable()` is false. */
  readonly unavailableModule?: string;
  /** Only called when `isAvailable()` is true. */
  compute(ctx: DashboardContext): Promise<unknown>;
}

/** The self-describing per-request output of one widget (spec FR-001). */
export type WidgetResult =
  | {
      id: string;
      displayType: WidgetDisplayType;
      title: string;
      section: WidgetSection;
      value: unknown;
      valueUnit?: 'currency';
      /** See `WidgetProvider.note` — a caveat for a figure that is true but partial. */
      note?: string;
    }
  | {
      id: string;
      displayType: WidgetDisplayType;
      title: string;
      section: WidgetSection;
      unavailable: {
        reason: 'module_pending';
        module: string;
        /**
         * Why this card cannot be filled, when "waiting on the {module} module" is not
         * the true answer (2026-10-12).
         *
         * The Statutory Calendar said it was waiting on Challans long after Challans
         * shipped. The real blocker is that nothing records statutory **due dates** or
         * what has been **filed** — a different problem with a different fix, and the
         * stock sentence actively misdirected whoever went looking.
         */
        note?: string;
      };
    };

/**
 * One row of a `list` widget (2026-10-12).
 *
 * A declared shape, because the renderer previously fell back to `JSON.stringify` for
 * any item that was not a string — so the first list widget to emit objects would have
 * printed raw JSON onto the dashboard. No widget had, which is the only reason it was
 * never seen.
 */
export interface WidgetListItem {
  label: string;
  /** Secondary line — "overdue by 6 days". */
  detail?: string;
  /** Drives the row's colour where the interface shows one. */
  severity?: string;
  /** Deep link into the owning module's screen, when the source offers one. */
  href?: string;
}

/** Multi-provider injection token every widget registers under (research.md §1). */
export const WIDGET_PROVIDERS = Symbol('WIDGET_PROVIDERS');

/**
 * Resolves one provider to its envelope: its `unavailable` state when its module is
 * not built, otherwise its computed value. A provider that throws mid-compute is
 * surfaced as unavailable rather than failing the whole dashboard — one broken card
 * must not blank the other seven.
 */
export async function resolveWidget(
  provider: WidgetProvider,
  ctx: DashboardContext,
): Promise<WidgetResult> {
  const base = {
    id: provider.id,
    displayType: provider.displayType,
    title: provider.title,
    section: provider.section,
  };
  if (!provider.isAvailable()) {
    return {
      ...base,
      unavailable: {
        reason: 'module_pending',
        module: provider.unavailableModule ?? 'unknown',
      },
    };
  }
  try {
    // Both in flight together: a note that reads the same rows as the value should not
    // double the card's latency to say one sentence.
    const [value, note] = await Promise.all([
      provider.compute(ctx),
      provider.note ? provider.note(ctx) : Promise.resolve(undefined),
    ]);
    return {
      ...base,
      value,
      ...(provider.valueUnit ? { valueUnit: provider.valueUnit } : {}),
      ...(note ? { note } : {}),
    };
  } catch {
    return {
      ...base,
      unavailable: { reason: 'module_pending', module: 'unknown' },
    };
  }
}

/**
 * Whether this caller is the audience for this widget.
 *
 * Short-circuits on an undeclared `requires`, so a placeholder — or any widget with
 * nothing to disclose — never reads the caller at all.
 */
export function isPermitted(
  provider: WidgetProvider,
  ctx: DashboardContext,
): boolean {
  return (
    !provider.requires ||
    provider.requires.some((p) => ctx.user.permissions.includes(p))
  );
}

/**
 * Resolves many providers in parallel, preserving registration order.
 *
 * A widget the caller is not entitled to is **omitted**, not returned as
 * `unavailable`. `unavailable` means "this module is not built yet" and the frontend
 * renders it as a Coming Soon card — telling somebody their leave queue is coming soon
 * when it exists and they simply may not see it would be a lie on the screen. Omitting
 * also costs nothing on the web: the dashboard renders the list it is given, in order,
 * with no per-id layout.
 *
 * Filtered here rather than in `DashboardService` so the company and site dashboards are
 * both covered by construction, and a third caller of this function cannot forget.
 */
export async function resolveWidgets(
  providers: WidgetProvider[],
  ctx: DashboardContext,
): Promise<WidgetResult[]> {
  return Promise.all(
    providers
      .filter((p) => isPermitted(p, ctx))
      .map((p) => resolveWidget(p, ctx)),
  );
}
