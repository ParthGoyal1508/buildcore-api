import { Injectable } from '@nestjs/common';
import { VendorType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { RlsContext, withRlsContext } from '../common/prisma/rls-context';
import { ProjectsService } from '../projects/portfolio/projects.service';

export interface VendorSummary {
  id: string;
  name: string;
  code: string;
  type: VendorType;
  active: boolean;
}

export interface VendorTds {
  tdsSection: string | null;
  tdsRate: number | null;
}

/**
 * The `partners` module's outward contract (007 FR-002, FR-009).
 *
 * These are in-process method calls, not HTTP. Inventory (009) and Machinery (006)
 * need a vendor's name and TDS terms when raising a bill, and Projects (008) needs
 * subcontractor cost for its P&L — Principle I routes all three through here rather
 * than letting another module query `partners.Vendor`.
 *
 * Every method returns `null` or `0` for an unknown id rather than throwing. A
 * consumer resolving a vendor reference on a historical document should render "not
 * found" beside that line, not fail the whole page.
 */
@Injectable()
export class PartnersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  async getVendorById(
    vendorId: string,
    ctx: RlsContext = { isSuperAdmin: true },
  ): Promise<VendorSummary | null> {
    const vendor = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.vendor.findUnique({
        where: { id: vendorId },
        select: { id: true, name: true, code: true, type: true, active: true },
      }),
    );
    return vendor ?? null;
  }

  async getVendorTds(
    vendorId: string,
    ctx: RlsContext = { isSuperAdmin: true },
  ): Promise<VendorTds | null> {
    const vendor = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.vendor.findUnique({
        where: { id: vendorId },
        select: { tdsSection: true, tdsRate: true },
      }),
    );
    if (!vendor) return null;
    return {
      tdsSection: vendor.tdsSection,
      tdsRate: vendor.tdsRate === null ? null : Number(vendor.tdsRate),
    };
  }

  /**
   * Subcontractor cost against a project, for the Project P&L (FR-009).
   *
   * TODO(008): this delegates to `ProjectsService.getWorkOrderTotalByProject()`,
   * which is itself a stub returning 0 until feature 008 ships work orders. The call
   * is wired through the real seam deliberately — when 008 implements that method,
   * this starts returning real figures with no change here.
   *
   * Until then it returns 0, which understates cost rather than failing. Any P&L
   * built on it must say so rather than presenting 0 as a measured figure.
   */
  async getSubcontractorCostByProject(
    projectId: string,
    dateRange?: { from?: Date; to?: Date },
  ): Promise<number> {
    return this.projects.getWorkOrderTotalByProject(projectId, dateRange);
  }
}
