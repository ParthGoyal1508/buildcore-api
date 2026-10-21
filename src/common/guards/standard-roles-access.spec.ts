import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessLevel, Permission } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { CategoriesController } from '../../inventory/categories/categories.controller';
import { ItemsController } from '../../inventory/items/items.controller';
import { VendorsController } from '../../partners/vendors/vendors.controller';
import { EquipmentController } from '../../plant/equipment/equipment.controller';
import { BoqController } from '../../projects/boq/boq.controller';
import { DwrController } from '../../projects/dwr/dwr.controller';
import { ProjectsController } from '../../projects/portfolio/projects.controller';
import { SitesController } from '../../projects/sites/sites.controller';
import { CompaniesController } from '../../settings/companies/companies.controller';
import { PermissionsGuard } from './permissions.guard';

/**
 * The client's standard roles (039) against the routes their daily work needs.
 *
 * DWR Entry holds `DWR`, Labour Supervisor `DAILY_WORKER_REGISTRY` and Storekeeper `INVENTORY` —
 * each with My Workspace and nothing else. A handful of read-only lookups owned by other modules
 * (the BOQ, sites, vendors, items, the project list) were widened for them; this asserts each
 * widening on the real decorators and the real guard, and that every **write** beside it was left
 * where it was.
 */

type Controller = abstract new (...args: never[]) => unknown;

/** A user holding `permissions` at read and write, as the standard-roles migration grants. */
function holder(...permissions: Permission[]): AuthenticatedUser {
  return {
    id: 'u1',
    companyId: 'c1',
    permissions: [...permissions, Permission.MY_WORKSPACE],
    grants: [...permissions, Permission.MY_WORKSPACE].flatMap((permission) => [
      { permission, level: AccessLevel.read },
      { permission, level: AccessLevel.write },
    ]),
  } as unknown as AuthenticatedUser;
}

function admits(
  user: AuthenticatedUser,
  controller: Controller,
  handler: string,
  method: string,
): boolean {
  const context = {
    getHandler: () =>
      (controller.prototype as Record<string, unknown>)[handler] as () => void,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user, method }) }),
  } as unknown as ExecutionContext;
  try {
    return new PermissionsGuard(new Reflector()).canActivate(context);
  } catch (err) {
    if (err instanceof ForbiddenException) return false;
    throw err;
  }
}

const DWR_ENTRY = holder(Permission.DWR);
const LABOUR_SUPERVISOR = holder(Permission.DAILY_WORKER_REGISTRY);
const STOREKEEPER = holder(Permission.INVENTORY);

describe('standard roles — the lookups their work needs (039)', () => {
  it('DWR Entry reads the DWR project picker and a project BOQ, and nothing else of the portfolio', () => {
    expect(admits(DWR_ENTRY, DwrController, 'projects', 'GET')).toBe(true);
    expect(admits(DWR_ENTRY, BoqController, 'tree', 'GET')).toBe(true);

    // The portfolio itself, its money and every BOQ write stay `PROJECTS`.
    expect(admits(DWR_ENTRY, ProjectsController, 'findAll', 'GET')).toBe(false);
    expect(admits(DWR_ENTRY, ProjectsController, 'findOne', 'GET')).toBe(false);
    expect(admits(DWR_ENTRY, BoqController, 'alerts', 'GET')).toBe(false);
    expect(admits(DWR_ENTRY, BoqController, 'createItem', 'POST')).toBe(false);
    expect(admits(DWR_ENTRY, BoqController, 'confirmImport', 'POST')).toBe(
      false,
    );
  });

  it('Storekeeper reads sites, projects, vendors, items, categories and machines, and writes none of them', () => {
    const reads: [Controller, string][] = [
      [SitesController, 'list'],
      [SitesController, 'findAll'],
      [SitesController, 'findOne'],
      [ProjectsController, 'findAll'],
      [VendorsController, 'findAll'],
      [VendorsController, 'findOne'],
      [ItemsController, 'findAll'],
      [ItemsController, 'findOne'],
      [CategoriesController, 'findAll'],
      [EquipmentController, 'findAll'],
    ];
    for (const [controller, handler] of reads) {
      expect([
        controller.name,
        handler,
        admits(STOREKEEPER, controller, handler, 'GET'),
      ]).toEqual([controller.name, handler, true]);
    }

    const writes: [Controller, string, string][] = [
      [SitesController, 'create', 'POST'],
      [SitesController, 'update', 'PATCH'],
      [ProjectsController, 'create', 'POST'],
      [VendorsController, 'create', 'POST'],
      [VendorsController, 'update', 'PATCH'],
      [ItemsController, 'create', 'POST'],
      [ItemsController, 'update', 'PATCH'],
      [CategoriesController, 'create', 'POST'],
      [EquipmentController, 'create', 'POST'],
    ];
    for (const [controller, handler, method] of writes) {
      expect([
        controller.name,
        handler,
        admits(STOREKEEPER, controller, handler, method),
      ]).toEqual([controller.name, handler, false]);
    }
    // Reads beyond the picker stay with their module.
    expect(admits(STOREKEEPER, ProjectsController, 'findOne', 'GET')).toBe(
      false,
    );
    expect(admits(STOREKEEPER, VendorsController, 'getTds', 'GET')).toBe(false);
    expect(admits(STOREKEEPER, EquipmentController, 'findOne', 'GET')).toBe(
      false,
    );
  });

  it('Labour Supervisor reads the project list for payment sheets, and nothing else of the portfolio', () => {
    expect(
      admits(LABOUR_SUPERVISOR, ProjectsController, 'findAll', 'GET'),
    ).toBe(true);
    expect(
      admits(LABOUR_SUPERVISOR, ProjectsController, 'findOne', 'GET'),
    ).toBe(false);
    expect(
      admits(LABOUR_SUPERVISOR, ProjectsController, 'create', 'POST'),
    ).toBe(false);
  });

  it('the company logo is read by every signed-in role, and still changed only with COMPANY_SETTINGS', () => {
    for (const user of [DWR_ENTRY, LABOUR_SUPERVISOR, STOREKEEPER]) {
      expect(admits(user, CompaniesController, 'getLogo', 'GET')).toBe(true);
      expect(admits(user, CompaniesController, 'setLogo', 'PUT')).toBe(false);
    }
  });
});
