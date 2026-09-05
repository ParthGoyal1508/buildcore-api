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
    }
  | {
      id: string;
      displayType: WidgetDisplayType;
      title: string;
      section: WidgetSection;
      unavailable: { reason: 'module_pending'; module: string };
    };

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
    return { ...base, value: await provider.compute(ctx) };
  } catch {
    return {
      ...base,
      unavailable: { reason: 'module_pending', module: 'unknown' },
    };
  }
}

/** Resolves many providers in parallel, preserving registration order. */
export async function resolveWidgets(
  providers: WidgetProvider[],
  ctx: DashboardContext,
): Promise<WidgetResult[]> {
  return Promise.all(providers.map((p) => resolveWidget(p, ctx)));
}
