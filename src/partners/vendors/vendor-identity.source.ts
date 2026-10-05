import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { withRlsContext } from '../../common/prisma/rls-context';
import type {
  ProjectVendorIdentitySource,
  VendorBillingIdentity,
} from '../../projects/portfolio/project-sources.registry';
import { ProjectSourcesRegistry } from '../../projects/portfolio/project-sources.registry';

/**
 * What `partners` contributes to a running-account bill's header (023 FR-026).
 *
 * ## Why the dependency points this way
 *
 * A bill to a subcontractor prints that subcontractor's name, code, registration number, permanent
 * account number, state and address. Those live on `partners.Vendor`, and Principle I forbids
 * `projects` from querying this schema — so the natural answer is to inject `VendorsService`.
 *
 * It cannot. **`PartnersModule` already imports `ProjectsModule`** (its vendors resolve project
 * sites), so importing it back closes a cycle across five modules. 018's `WorkOrdersService` hit
 * the same wall and chose to store `partnerId` unvalidated, recording the consequence; 023 cannot
 * make that trade, because a header is not a validation — it is content the document prints.
 *
 * So the dependency is inverted, exactly as 022 inverted the equipment logbook and 021 inverted
 * search: **this module registers itself**, and `projects` reads through an interface without
 * knowing who answers it. The cycle never forms because nothing new is imported in the direction
 * that would close it.
 *
 * ## Why it may return null
 *
 * A work order with no partner on it is possible — the column is nullable — and a vendor id that
 * matches no row is possible for the reason 018 recorded. Either way the answer is *unknown*, not
 * an error: FR-027 requires a missing party identifier be **reported rather than refused**, so the
 * bill is produced with blanks and the fields are listed in `missingHeaderFields`.
 */
@Injectable()
export class VendorIdentitySource
  implements ProjectVendorIdentitySource, OnModuleInit
{
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: ProjectSourcesRegistry,
  ) {}

  onModuleInit(): void {
    this.sources.registerVendorIdentitySource(this);
  }

  async getBillingIdentity(
    vendorId: string,
    companyId: string,
  ): Promise<VendorBillingIdentity | null> {
    // Scoped by `companyId` in the predicate **and** by the policy: a bill's header is read while
    // composing for one company, and a vendor id from another is simply not found.
    const vendor = await withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId },
      (tx) =>
        tx.vendor.findFirst({
          where: { id: vendorId, companyId },
          select: {
            code: true,
            name: true,
            gstin: true,
            pan: true,
            state: true,
            address: true,
          },
        }),
    );
    return vendor ?? null;
  }
}
