import { InventoryService } from '../../inventory/inventory.service';
import { PlantService } from '../../plant/plant.service';
import {
  costSourceFromPerProject,
  type ProjectCostSource,
} from './project-sources.registry';

/**
 * The cost sources the P&L asks (018 T026 to T028, FR-010).
 *
 * Until a module registers, the P&L names its category in `unavailableCategories` and leaves it out
 * of the totals — which is correct, and is also a project whose costs are invisible. These
 * registrations are what turn that into a measured figure, so the thing worth asserting is that each
 * module actually registers, under the category the P&L looks for.
 */

const range = {
  from: new Date('2026-09-01T00:00:00.000Z'),
  to: new Date('2026-09-30T23:59:59.999Z'),
};

function collectRegistrations(): {
  registry: { registerCostSource: (source: ProjectCostSource) => void };
  registered: ProjectCostSource[];
} {
  const registered: ProjectCostSource[] = [];
  return {
    registry: {
      registerCostSource: (source: ProjectCostSource) =>
        registered.push(source),
    },
    registered,
  };
}

describe('costSourceFromPerProject', () => {
  it('asks once per project and keys the answers by project', async () => {
    const asked: string[] = [];
    const source = costSourceFromPerProject('materials', async (projectId) => {
      asked.push(projectId);
      return projectId === 'p-1' ? 1000 : 250;
    });

    const costs = await source.costsByProject(['p-1', 'p-2'], 'co-1', range);

    expect(asked).toEqual(['p-1', 'p-2']);
    expect([...costs.entries()]).toEqual([
      ['p-1', 1000],
      ['p-2', 250],
    ]);
  });

  it('does not clamp a negative figure (T027, returned material)', async () => {
    // A credit note for material sent back is a negative amount. Clamping it at zero reports the
    // return as if it never happened, while the stock ledger says it did — and the project's
    // material cost then disagrees with its own store.
    const source = costSourceFromPerProject('materials', async () => -4200);

    const costs = await source.costsByProject(['p-1'], 'co-1', range);

    expect(costs.get('p-1')).toBe(-4200);
  });

  it('declares the category the P&L looks the source up by', () => {
    expect(costSourceFromPerProject('fuel', async () => 0).category).toBe(
      'fuel',
    );
  });
});

describe('plant registers both of its categories (T028)', () => {
  const build = () => {
    const { registry, registered } = collectRegistrations();
    const service = new PlantService(
      { $transaction: async () => 0 } as never,
      { getSitesByProject: async () => [] } as never,
      {
        registerMachinerySource: () => undefined,
        // 022 FR-032: `PlantService` also announces its equipment logbook, so a daily work report
        // can show a machine's own register page beside a presence-paid line. Stubbed here rather
        // than collected, because this suite is about the **cost** sources — but it has to exist,
        // and that is the point worth recording: this fake registry is a hand-written stand-in, so
        // every new registration on the real one breaks it until it is added. That is a feature.
        // A fake that silently tolerated unknown registrations would let a module stop announcing
        // itself without any test noticing, and an unregistered source presents as a cost of zero.
        registerLogbookSource: () => undefined,
        ...registry,
      } as never,
    );
    return { service, registered };
  };

  it('announces machinery and fuel separately', () => {
    const { service, registered } = build();

    service.onModuleInit();

    expect(registered.map((source) => source.category)).toEqual([
      'machinery',
      'fuel',
    ]);
  });

  it('answers through the shipped per-project methods', async () => {
    const { service, registered } = build();
    service.onModuleInit();
    const machinery = registered.find(
      (source) => source.category === 'machinery',
    );

    // No sites, so the shipped method returns 0 by design rather than throwing — which is what
    // keeps one uncomputable project from taking the other fifty-nine down with it.
    const costs = await machinery?.costsByProject(['p-1'], 'co-1', range);

    expect(costs?.get('p-1')).toBe(0);
  });
});

describe('inventory registers materials (T027)', () => {
  it('announces itself under the category the P&L asks for', () => {
    const { registry, registered } = collectRegistrations();
    const service = new InventoryService(
      {} as never,
      { getSitesByProject: async () => [] } as never,
      { materialCostForSites: async () => 0 } as never,
      {} as never,
      { registerMaterialsSource: () => undefined, ...registry } as never,
    );

    service.onModuleInit();

    expect(registered.map((source) => source.category)).toEqual(['materials']);
  });
});
