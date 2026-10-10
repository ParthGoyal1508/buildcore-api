import { Permission } from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/authenticated-user';
import type { DashboardContext } from '../context';
import {
  resolveWidget,
  resolveWidgets,
  type WidgetProvider,
} from './widget.types';

const ctx = {} as DashboardContext;

/** A caller holding exactly `permissions`. Only `user.permissions` is read. */
function contextFor(permissions: Permission[]): DashboardContext {
  return { user: { permissions } as AuthenticatedUser } as DashboardContext;
}

/** A real widget that is nobody's business without `requires`. */
function restricted(
  id: string,
  requires: Permission[],
): WidgetProvider & { computed: number } {
  const provider = {
    ...realWidget(id, 7),
    requires,
    computed: 0,
    compute: () => {
      provider.computed += 1;
      return Promise.resolve(7);
    },
  };
  return provider;
}

function realWidget(id: string, value: unknown): WidgetProvider {
  return {
    id,
    displayType: 'kpi',
    title: id,
    section: 'kpi',
    isAvailable: () => true,
    compute: () => Promise.resolve(value),
  };
}

function placeholder(id: string, module: string): WidgetProvider {
  return {
    id,
    displayType: 'kpi',
    title: id,
    section: 'kpi',
    unavailableModule: module,
    isAvailable: () => false,
    compute: () => Promise.reject(new Error('never')),
  };
}

describe('resolveWidget', () => {
  it('resolves an available widget to its value', async () => {
    const result = await resolveWidget(realWidget('a', 42), ctx);
    expect(result).toMatchObject({ id: 'a', value: 42 });
  });

  it('resolves an unavailable widget to its module_pending envelope', async () => {
    const result = await resolveWidget(placeholder('b', 'machinery'), ctx);
    expect(result).toMatchObject({
      id: 'b',
      unavailable: { reason: 'module_pending', module: 'machinery' },
    });
  });

  it('surfaces a throwing widget as unavailable rather than failing', async () => {
    const boom: WidgetProvider = {
      id: 'c',
      displayType: 'kpi',
      title: 'c',
      section: 'kpi',
      isAvailable: () => true,
      compute: () => Promise.reject(new Error('boom')),
    };
    const result = await resolveWidget(boom, ctx);
    expect(result).toHaveProperty('unavailable');
  });
});

describe('resolveWidgets', () => {
  it('preserves registration order', async () => {
    const results = await resolveWidgets(
      [realWidget('a', 1), realWidget('b', 2)],
      ctx,
    );
    expect(results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('registering a new placeholder does not change existing outputs (SC-003)', async () => {
    const before = await resolveWidgets(
      [realWidget('a', 1), realWidget('b', 2)],
      ctx,
    );
    const after = await resolveWidgets(
      [realWidget('a', 1), placeholder('new', 'fuel'), realWidget('b', 2)],
      ctx,
    );
    const pick = (id: string, list: typeof before) =>
      list.find((r) => r.id === id);
    expect(pick('a', after)).toEqual(pick('a', before));
    expect(pick('b', after)).toEqual(pick('b', before));
  });
});

/**
 * Who a widget is for (2026-10-10).
 *
 * `/dashboard/widgets` is gated on DASHBOARD alone, which every employee holds, so a
 * site engineer's dashboard carried the company's headcount, today's absentees and a
 * Recent Leaves table naming employees and their dates — none of it on a screen they
 * can open.
 */
describe('resolveWidgets — entitlement', () => {
  it('omits a widget the caller holds no permission for', async () => {
    const providers = [
      restricted('headcount', [Permission.EMPLOYEES]),
      realWidget('always', 1),
    ];

    const admin = await resolveWidgets(
      providers,
      contextFor([Permission.EMPLOYEES]),
    );
    const engineer = await resolveWidgets(
      providers,
      contextFor([Permission.DASHBOARD]),
    );

    // The pair is the test: the same registry, two callers. Asserting only that the
    // admin sees it would have passed against the defect — everybody saw it.
    expect(admin.map((r) => r.id)).toEqual(['headcount', 'always']);
    expect(engineer.map((r) => r.id)).toEqual(['always']);
  });

  it('omits rather than marking unavailable', async () => {
    // `unavailable` means "module not built yet" and renders as a Coming Soon card.
    // A leave queue that exists and is simply not theirs must not say that.
    const [only] = await resolveWidgets(
      [
        restricted('headcount', [Permission.EMPLOYEES]),
        realWidget('always', 1),
      ],
      contextFor([]),
    );
    expect(only.id).toBe('always');
  });

  it('does not compute a widget it withholds', async () => {
    const widget = restricted('headcount', [Permission.EMPLOYEES]);
    await resolveWidgets([widget], contextFor([Permission.DASHBOARD]));
    expect(widget.computed).toBe(0);
  });

  it('admits on any one of several permissions, as @RequirePermissions does', async () => {
    const widget = restricted('pending', [
      Permission.ATTENDANCE,
      Permission.MAINTENANCE,
    ]);
    const results = await resolveWidgets(
      [widget],
      contextFor([Permission.MAINTENANCE]),
    );
    expect(results.map((r) => r.id)).toEqual(['pending']);
  });

  it('keeps a widget that declares no permission — a placeholder names a module, not data', async () => {
    const results = await resolveWidgets(
      [placeholder('fuel-cost', 'fuel')],
      contextFor([]),
    );
    expect(results).toHaveLength(1);
  });
});
