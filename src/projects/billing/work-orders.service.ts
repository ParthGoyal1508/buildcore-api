import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CodeSeriesType, WorkOrderStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { RlsContext } from '../../common/prisma/rls-context';
import { withRlsContext } from '../../common/prisma/rls-context';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';

/** `PRPL-WO-0001`. The slot every other series in this product fills the same way. */
const WORK_ORDER_CODE_INFIX = 'WO';

export interface WorkOrderInput {
  projectId: string;
  /** `partners.Vendor.id`. Optional — a work order can be raised before the vendor is chosen. */
  partnerId?: string | null;
  workDetail: string;
  terms?: string | null;
  requirements?: string | null;
  hireContract?: string | null;
  labourAmount?: number;
  materialAmount?: number;
  /** Retention withheld per RA bill, as a fraction. `0.05` is 5%. */
  retentionPercent?: number;
  status?: WorkOrderStatus;
}

export interface WorkOrderView {
  id: string;
  projectId: string;
  partnerId: string | null;
  code: string | null;
  workDetail: string;
  terms: string | null;
  requirements: string | null;
  hireContract: string | null;
  labourAmount: number;
  materialAmount: number;
  retentionPercent: number;
  status: WorkOrderStatus;
  /** Award lines captured against it. 0 means nothing can be measured against it yet. */
  awardLineCount: number;
  /** RA bills raised against it. */
  billCount: number;
  createdAt: Date;
}

/**
 * Work orders, in the minimal form feature 018 needs (018 US2).
 *
 * ## Why this is here, and what it is not
 *
 * **This is feature 008 User Story 6's surface, delivered in the smallest form that makes 018
 * reachable.** The `WorkOrder` table has existed since 008 and *nothing has ever written to it* —
 * `ProjectsService.getWorkOrderTotalByProject()` says so in its own comment and returns 0. 018's
 * FR-006 to FR-009 are all measured against a work order's award, so without a way to create one,
 * the RA bill sheet, the award capture and the approval invalidation are a screen nobody can reach:
 * half of `bugs.md` item 12, built and unreachable.
 *
 * So this exists, and it is deliberately **not** 008 US6:
 *
 *   * no approval chain on raising one — 008 will decide whether a work order needs one;
 *   * no vendor validation, see below;
 *   * no deletion, because an RA bill references it and a work order with bills against it is a
 *     contract, not a draft;
 *   * no letter issue, no terms templating, none of the document generation 017 gave letters.
 *
 * When 008 US6 is specified properly it should take this over rather than add a second surface.
 *
 * ## `partnerId` is stored, not validated
 *
 * `PartnersService.getVendorById()` exists and is the right way to check it — but `PartnersModule`
 * imports `ProjectsModule` (its vendors resolve project sites), so importing it back would close a
 * cycle across five modules. That is a real cost for a validation the UI already performs by picking
 * from the vendor list it loaded. The id is stored as given and the web resolves the name through
 * the partners endpoints it already calls.
 *
 * The honest consequence: a hand-crafted request can store a partner id that matches no vendor, and
 * it will read back as an unknown partner rather than being refused. Recorded rather than hidden.
 */
@Injectable()
export class WorkOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codeSeries: CodeSeriesService,
  ) {}

  async listForProject(
    ctx: RlsContext,
    projectId: string,
  ): Promise<WorkOrderView[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.workOrder.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { awardLines: true, raBills: true } },
        },
      }),
    );
    return rows.map(shape);
  }

  async view(ctx: RlsContext, id: string): Promise<WorkOrderView> {
    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.workOrder.findFirst({
        where: { id },
        include: {
          _count: { select: { awardLines: true, raBills: true } },
        },
      }),
    );
    if (!row) throw new NotFoundException('Work order not found');
    return shape(row);
  }

  async create(
    ctx: RlsContext,
    companyId: string,
    input: WorkOrderInput,
  ): Promise<WorkOrderView> {
    const created = await withRlsContext(this.prisma, ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: input.projectId },
        select: { id: true },
      });
      if (!project) throw new NotFoundException('Project not found');

      // Allocated inside this transaction so a later failure rolls the number back rather than
      // burning it — a gap in the series reads as a deleted work order to anyone auditing it.
      // The same rule project and vendor codes follow.
      const code = await this.codeSeries.next(
        tx,
        companyId,
        CodeSeriesType.WORK_ORDER,
        WORK_ORDER_CODE_INFIX,
      );

      return tx.workOrder.create({
        data: {
          companyId,
          code,
          projectId: input.projectId,
          partnerId: input.partnerId ?? null,
          workDetail: input.workDetail.trim(),
          terms: input.terms ?? null,
          requirements: input.requirements ?? null,
          hireContract: input.hireContract ?? null,
          labourAmount: input.labourAmount ?? 0,
          materialAmount: input.materialAmount ?? 0,
          retentionPercent: input.retentionPercent ?? 0,
          status: input.status ?? WorkOrderStatus.draft,
        },
        select: { id: true },
      });
    });
    return this.view(ctx, created.id);
  }

  /**
   * Edits a work order's details, its retention and its status.
   *
   * **`retentionPercent` is refused once a bill has been raised.** The retention on an issued RA
   * bill is already withheld at the old rate, and changing the basis afterwards would make the
   * subcontractor's copy disagree with ours about money already held — the same reasoning that
   * refuses replacing an award that has been measured against.
   */
  async update(
    ctx: RlsContext,
    id: string,
    input: Partial<WorkOrderInput>,
  ): Promise<WorkOrderView> {
    await withRlsContext(this.prisma, ctx, async (tx) => {
      const existing = await tx.workOrder.findFirst({
        where: { id },
        select: {
          id: true,
          retentionPercent: true,
          _count: { select: { raBills: true } },
        },
      });
      if (!existing) throw new NotFoundException('Work order not found');

      if (
        input.retentionPercent !== undefined &&
        existing._count.raBills > 0 &&
        input.retentionPercent !== existing.retentionPercent.toNumber()
      ) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'WORK_ORDER_RETENTION_LOCKED',
          message:
            'Bills have been raised against this work order, so its retention basis cannot be ' +
            'changed. The retention on an issued bill is already withheld at the old rate, and ' +
            'moving the basis would make the subcontractor’s copy disagree with ours about money ' +
            'already held.',
        });
      }

      await tx.workOrder.update({
        where: { id },
        data: {
          partnerId: input.partnerId ?? undefined,
          workDetail: input.workDetail?.trim(),
          terms: input.terms ?? undefined,
          requirements: input.requirements ?? undefined,
          hireContract: input.hireContract ?? undefined,
          labourAmount: input.labourAmount,
          materialAmount: input.materialAmount,
          retentionPercent: input.retentionPercent,
          status: input.status,
        },
      });
    });
    return this.view(ctx, id);
  }
}

type Row = {
  id: string;
  projectId: string;
  partnerId: string | null;
  code: string | null;
  workDetail: string;
  terms: string | null;
  requirements: string | null;
  hireContract: string | null;
  labourAmount: { toNumber(): number };
  materialAmount: { toNumber(): number };
  retentionPercent: { toNumber(): number };
  status: WorkOrderStatus;
  createdAt: Date;
  _count: { awardLines: number; raBills: number };
};

const shape = (row: Row): WorkOrderView => ({
  id: row.id,
  projectId: row.projectId,
  /** Null only on work orders raised before 027 numbered them. */
  code: row.code,
  partnerId: row.partnerId,
  workDetail: row.workDetail,
  terms: row.terms,
  requirements: row.requirements,
  hireContract: row.hireContract,
  labourAmount: row.labourAmount.toNumber(),
  materialAmount: row.materialAmount.toNumber(),
  retentionPercent: row.retentionPercent.toNumber(),
  status: row.status,
  awardLineCount: row._count.awardLines,
  billCount: row._count.raBills,
  createdAt: row.createdAt,
});
