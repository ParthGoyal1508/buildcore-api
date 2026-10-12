import { Injectable } from '@nestjs/common';
import { Permission } from '@prisma/client';

import { PlantService } from '../../plant/plant.service';
import type { DashboardContext } from '../context';
import type {
  FilterSpec,
  ReportData,
  ReportProvider,
  ReportRunParams,
} from './report.types';

/**
 * The three plant reports the contract names (spec FR-019), all read through
 * `PlantService` (Principle I).
 *
 * They were placeholders reporting `module_pending` against a module named "machinery"
 * and one named "fuel". Both shipped long ago — the same false blame the dashboard's
 * widgets carried until 2026-10-12, and from the same cause: a placeholder outliving
 * the thing it stood in for, with nothing to make it fail.
 *
 * ## The column sets mirror each module's own screen
 *
 * Chosen rather than invented: Machinery lists what the Register lists, Fuel lists what
 * the Fuel screen's table shows, and Utilization is the one figure the Register already
 * surfaces per machine. A report whose columns nobody recognises from the screen they
 * came from is a report people check against the screen and then stop using.
 */

/** The calendar range a run was asked for, defaulting to the current month. */
function runRange(params: ReportRunParams): { from: Date; to: Date } {
  const now = new Date();
  const from = params.fromDate
    ? new Date(`${params.fromDate}T00:00:00.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = params.toDate
    ? new Date(`${params.toDate}T23:59:59.999Z`)
    : new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth() + 1,
          0,
          23,
          59,
          59,
          999,
        ),
      );
  return { from, to };
}

/** The machinery register as a file (spec FR-019). */
@Injectable()
export class MachineryReportProvider implements ReportProvider {
  readonly id = 'machinery';
  readonly name = 'Machinery';
  readonly requires = [Permission.MACHINERY];
  /** None: the register is a present-tense list, not a period. */
  readonly filters: FilterSpec[] = [];

  constructor(private readonly plant: PlantService) {}

  isAvailable(): boolean {
    return this.plant.isAvailable();
  }

  async run(ctx: DashboardContext): Promise<ReportData> {
    const rows = await this.plant.listEquipmentForReport(ctx.user);
    return {
      columns: [
        { key: 'code', label: 'Code' },
        { key: 'name', label: 'Machine' },
        { key: 'category', label: 'Category' },
        { key: 'ownership', label: 'Ownership' },
        { key: 'site', label: 'Deployed at' },
        { key: 'status', label: 'Status' },
      ],
      rows: rows.map((row) => ({
        code: row.code,
        name: row.name,
        category: row.category,
        ownership: row.ownership,
        site: row.site,
        status: row.status,
      })),
    };
  }
}

/**
 * How hard each machine is working (spec FR-019).
 *
 * The same read as the Machinery report with the meter beside the percentage, because
 * the percentage alone invites the question the reading answers: a machine at 12% on an
 * hour meter and one at 12% on a kilometre meter are different conversations.
 */
@Injectable()
export class EquipmentUtilizationReportProvider implements ReportProvider {
  readonly id = 'equipment-utilization';
  readonly name = 'Equipment Utilization';
  readonly requires = [Permission.MACHINERY];
  readonly filters: FilterSpec[] = [];

  constructor(private readonly plant: PlantService) {}

  isAvailable(): boolean {
    return this.plant.isAvailable();
  }

  async run(ctx: DashboardContext): Promise<ReportData> {
    const rows = await this.plant.listEquipmentForReport(ctx.user);
    return {
      columns: [
        { key: 'code', label: 'Code' },
        { key: 'name', label: 'Machine' },
        { key: 'site', label: 'Deployed at' },
        { key: 'utilizationPercent', label: 'Utilisation %' },
        { key: 'currentReading', label: 'Meter reading' },
        { key: 'meterType', label: 'Meter' },
        { key: 'status', label: 'Status' },
      ],
      rows: rows.map((row) => ({
        code: row.code,
        name: row.name,
        site: row.site,
        utilizationPercent: row.utilizationPercent,
        currentReading: row.currentReading,
        meterType: row.meterType,
        status: row.status,
      })),
    };
  }
}

/** Every fuel entry in a period (spec FR-019). */
@Injectable()
export class FuelReportProvider implements ReportProvider {
  readonly id = 'fuel';
  readonly name = 'Fuel';
  readonly requires = [Permission.FUEL, Permission.MACHINERY];
  readonly filters: FilterSpec[] = [
    { key: 'fromDate', label: 'From', type: 'date' },
    { key: 'toDate', label: 'To', type: 'date' },
  ];

  constructor(private readonly plant: PlantService) {}

  isAvailable(): boolean {
    return this.plant.isAvailable();
  }

  async run(
    ctx: DashboardContext,
    params: ReportRunParams,
  ): Promise<ReportData> {
    const rows = await this.plant.listFuelForReport(ctx.user, runRange(params));
    return {
      columns: [
        { key: 'date', label: 'Date' },
        { key: 'code', label: 'Code' },
        { key: 'machine', label: 'Machine' },
        { key: 'site', label: 'Drawn at' },
        { key: 'litres', label: 'Litres' },
        { key: 'rate', label: 'Rate' },
        { key: 'amount', label: 'Amount' },
        { key: 'flagged', label: 'Over benchmark' },
      ],
      rows: rows.map((row) => ({ ...row })),
    };
  }
}
