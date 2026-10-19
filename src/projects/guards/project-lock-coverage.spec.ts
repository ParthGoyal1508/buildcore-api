import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';

import { ClientBillsController } from '../billing/client-bills.controller';
import { RaBillsController } from '../billing/ra-bills.controller';
import { WorkOrdersController } from '../billing/work-orders.controller';
import { DwrController } from '../dwr/dwr.controller';
import { BillPackageController } from '../billing/package/bill-package.controller';
import { ProjectsController } from '../portfolio/projects.controller';
import { ProjectLockGuard } from './project-lock.guard';

/**
 * 036 I2: the RA bill, client bill and work order controllers carried no lock guard at
 * all, so a locked project still took bills and awards. This asserts the guard is on
 * every write of each billing controller, so a write added later without it fails here
 * rather than in front of a client.
 */
const WRITES = [
  RequestMethod.POST,
  RequestMethod.PATCH,
  RequestMethod.PUT,
  RequestMethod.DELETE,
];

/** Writes that read rather than change anything, and so are deliberately unguarded. */
const READ_ONLY_POSTS = new Set([
  'BillPackageController.previewDebitNote',
  'BillPackageController.readCertifiedCopy',
]);

function unguardedWrites(controller: new (...args: never[]) => unknown) {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .filter((name) => {
      const handler = proto[name] as object;
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      return WRITES.includes(method);
    })
    .filter((name) => {
      const guards: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, proto[name] as object) ?? [];
      return !guards.includes(ProjectLockGuard);
    })
    .map((name) => `${controller.name}.${name}`)
    .filter((name) => !READ_ONLY_POSTS.has(name));
}

describe('ProjectLockGuard coverage (036 I1/I2)', () => {
  it.each([
    RaBillsController,
    ClientBillsController,
    WorkOrdersController,
    DwrController,
    BillPackageController,
  ])('guards every write on %p', (controller) => {
    expect(unguardedWrites(controller)).toEqual([]);
  });

  it('guards project delete, and leaves the PATCH that unlocks it open', () => {
    expect(unguardedWrites(ProjectsController)).toEqual([
      'ProjectsController.create',
      'ProjectsController.update',
    ]);
  });
});
