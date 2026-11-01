import { Injectable } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { InventoryService } from '../../inventory/inventory.service';
import { LabourService } from '../../labour/labour.service';
import { PlantService } from '../../plant/plant.service';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import type { DashboardContext } from '../context';
import { once } from '../context';
import type { WidgetProvider } from './widget.types';

/**
 * The Held and Outgoing money panels (054, 2026-11-02 — the client: "total outstanding for
 * vendor, for labour, for inventory … panels like amount coming from client, amount held,
 * amount outgoing").
 *
 * Each figure is read from the module that owns it, through the same rule its own screen
 * totals by, with hidden cash left out (038):
 * - material: `InventoryService.unpaidBillsTotal` — unpaid purchase bills less allocations;
 * - subcontractors: `ProjectsService.getSubcontractorPosition` — certified RA bills less paid;
 * - labour: `LabourService.wagesOwed` — pending lines of approved sheets and uncarried
 *   short-payments;
 * - plant: `PlantService.unpaidBillsTotals` — hire bills, service bills and job-card bills.
 *
 * Every part carries the permission its screen is gated on, and a caller sees only the parts
 * they hold — the Total Outgoing card included, so it never adds in money from a screen the
 * caller cannot open.
 */

type OutgoingPart =
  | 'material'
  | 'subcontractors'
  | 'labour'
  | 'hire'
  | 'maintenance';

const PART_PERMISSIONS: Record<OutgoingPart, Permission[]> = {
  material: [Permission.INVENTORY],
  subcontractors: [Permission.PROJECT_FINANCIALS],
  labour: [Permission.DAILY_WORKER_REGISTRY, Permission.LABOUR_APPROVE],
  hire: [Permission.HIRE_BILLS],
  maintenance: [Permission.MAINTENANCE, Permission.MAINTENANCE_PAY],
};

const mayRead = (ctx: DashboardContext, part: OutgoingPart) =>
  PART_PERMISSIONS[part].some((p) => ctx.user.permissions.includes(p));

@Injectable()
export class OutgoingSources {
  constructor(
    private readonly inventory: InventoryService,
    private readonly projects: ProjectsService,
    private readonly labour: LabourService,
    private readonly plant: PlantService,
  ) {}

  /** One part's figure, read once per dashboard request; 0 for a part the caller may not see. */
  async part(ctx: DashboardContext, part: OutgoingPart): Promise<number> {
    if (!mayRead(ctx, part)) return 0;
    const id = ctx.companyId;
    switch (part) {
      case 'material':
        return once(ctx, 'money:material', () =>
          this.inventory.unpaidBillsTotal(id),
        );
      case 'subcontractors':
        return (await this.subcontractors(ctx)).outstanding;
      case 'labour':
        return once(ctx, 'money:labour', () => this.labour.wagesOwed(id));
      case 'hire':
      case 'maintenance':
        return (
          await once(ctx, 'money:plant', () => this.plant.unpaidBillsTotals(id))
        )[part];
    }
  }

  subcontractors(ctx: DashboardContext) {
    return once(ctx, 'money:subcontractors', () =>
      this.projects.getSubcontractorPosition(ctx.companyId),
    );
  }

  async sum(ctx: DashboardContext, parts: OutgoingPart[]): Promise<number> {
    const values = await Promise.all(parts.map((p) => this.part(ctx, p)));
    return Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100;
  }
}

@Injectable()
abstract class OutgoingWidget implements WidgetProvider {
  abstract readonly id: string;
  abstract readonly title: string;
  protected abstract readonly parts: OutgoingPart[];
  readonly displayType = 'kpi' as const;
  readonly valueUnit = 'currency' as const;
  readonly section = 'money' as const;
  constructor(protected readonly sources: OutgoingSources) {}
  get requires(): Permission[] {
    return [...new Set(this.parts.flatMap((p) => PART_PERMISSIONS[p]))];
  }
  isAvailable(): boolean {
    return true;
  }
  compute(ctx: DashboardContext): Promise<number> {
    return this.sources.sum(ctx, this.parts);
  }
}

@Injectable()
export class MaterialPayableWidget extends OutgoingWidget {
  readonly id = 'payable-material';
  readonly title = 'Material Vendors';
  protected readonly parts: OutgoingPart[] = ['material'];
}

@Injectable()
export class SubcontractorPayableWidget extends OutgoingWidget {
  readonly id = 'payable-subcontractors';
  readonly title = 'Subcontractors';
  protected readonly parts: OutgoingPart[] = ['subcontractors'];
}

@Injectable()
export class LabourPayableWidget extends OutgoingWidget {
  readonly id = 'payable-labour';
  readonly title = 'Labour';
  protected readonly parts: OutgoingPart[] = ['labour'];
}

@Injectable()
export class PlantPayableWidget extends OutgoingWidget {
  readonly id = 'payable-plant';
  readonly title = 'Plant & Service Vendors';
  protected readonly parts: OutgoingPart[] = ['hire', 'maintenance'];
}

/** Every bill still to be cleared, across the parts the caller may see. */
@Injectable()
export class TotalPayableWidget extends OutgoingWidget {
  readonly id = 'payable-total';
  readonly title = 'Total Outgoing';
  protected readonly parts: OutgoingPart[] = [
    'material',
    'subcontractors',
    'labour',
    'hire',
    'maintenance',
  ];
}

/** Retention the company keeps back from its subcontractors, less what it has released. */
@Injectable()
export class HeldFromSubcontractorsWidget implements WidgetProvider {
  readonly id = 'held-from-subcontractors';
  readonly title = 'Held from Subcontractors';
  readonly displayType = 'kpi' as const;
  readonly valueUnit = 'currency' as const;
  readonly section = 'money' as const;
  readonly requires = [Permission.PROJECT_FINANCIALS];
  constructor(private readonly sources: OutgoingSources) {}
  isAvailable(): boolean {
    return true;
  }
  async compute(ctx: DashboardContext): Promise<number> {
    return (await this.sources.subcontractors(ctx)).retentionHeld;
  }
}
