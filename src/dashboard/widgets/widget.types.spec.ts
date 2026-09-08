import type { DashboardContext } from '../context';
import {
  resolveWidget,
  resolveWidgets,
  type WidgetProvider,
} from './widget.types';

const ctx = {} as DashboardContext;

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
