import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  CodeSeriesType,
  Prisma,
  Project,
  ProjectStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { EmployeesService } from '../../hr/employees/employees.service';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PROJECT_CODE_INFIX,
} from '../constants/projects.constants';
import {
  CreateProjectDto,
  ListProjectsDto,
  UpdateProjectDto,
} from './dto/project.dto';

/** One project's contract value, as the cess calculation needs it. */
export interface ProjectContractValue {
  projectId: string;
  name: string;
  contractValue: number;
}

export interface ProjectListItem {
  id: string;
  code: string;
  name: string;
  client: string;
  location: string | null;
  contractValue: number;
  status: ProjectStatus;
  startDate: Date;
  expectedEndDate: Date | null;
  isLocked: boolean;
}

export interface ProjectListPage {
  items: ProjectListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The aggregated project detail (`GET /projects/:id`).
 *
 * `unavailableModules` names every source that could not be consulted because the
 * feature that owns it has not shipped. An empty `machinery` array with `plant` in
 * this list means "we could not ask"; an empty array without it means "we asked and
 * there is none". Collapsing the two would let a project page assert, in the same
 * shape, both that no machinery is deployed and that nobody knows.
 */
export interface ProjectDetail {
  project: Project;
  tabs: {
    employees: {
      id: string;
      employeeCode: string;
      name: string;
      designationId: string | null;
    }[];
    machinery: unknown[];
    materials: unknown[];
    dwrSummary: { count: number; latestDate: Date | null };
    billSummary: { totalBills: number; totalExpenses: number };
    revenueSummary: { totalReceived: number; totalPending: number };
  };
  unavailableModules: string[];
}

/**
 * Project portfolio (008 US3), and the `projects` module's outward contract for the
 * Project master.
 *
 * The three outward methods at the bottom were written as stubs by 007, which needed
 * to call them before this feature existed. They are now real — that was the whole
 * point of routing 007 through the seam rather than around it, and no caller of
 * theirs changes.
 */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly codeSeries: CodeSeriesService,
    // See SitesService for why this edge needs forwardRef.
    @Inject(forwardRef(() => EmployeesService))
    private readonly employees: EmployeesService,
  ) {}

  /** See `ClientsService.targetCompanyOf()` for why the caller's own company is the
   * fallback rather than an immediate refusal. */
  private targetCompanyOf(
    caller: AuthenticatedUser,
    requested?: string,
  ): string {
    const scope = companyScope(caller, requested);
    const companyId = scope.companyId ?? caller.companyId;
    if (!companyId) {
      throw new BadRequestException(
        'companyId is required for a cross-company caller.',
      );
    }
    return companyId;
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateProjectDto,
    ipAddress: string,
    companyId?: string,
  ): Promise<Project> {
    const targetCompanyId = this.targetCompanyOf(caller, companyId);

    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // The client must exist and belong to the same company. RLS would not catch
        // a foreign client id on its own: both rows live in `projects`, so the
        // insert reads as an ordinary same-schema write.
        const client = await tx.client.findFirst({
          where: { id: dto.clientId, companyId: targetCompanyId },
          select: { id: true },
        });
        if (!client) {
          throw new NotFoundException(`Client ${dto.clientId} not found`);
        }

        // Allocated inside this transaction so a later failure rolls the number back
        // rather than burning it — a gap in a project code series reads as a deleted
        // project to anyone auditing it later. Same rule vendor codes follow.
        const code =
          dto.code?.trim() ||
          (await this.codeSeries.next(
            tx,
            targetCompanyId,
            CodeSeriesType.PROJECTS,
            PROJECT_CODE_INFIX,
          ));

        return tx.project.create({
          data: {
            companyId: targetCompanyId,
            code,
            name: dto.name.trim(),
            clientId: dto.clientId,
            location: dto.location ?? null,
            contractValue: dto.contractValue,
            startDate: new Date(dto.startDate),
            expectedEndDate: dto.expectedEndDate
              ? new Date(dto.expectedEndDate)
              : null,
            status: dto.status ?? ProjectStatus.planning,
            projectManagerEmployeeId: dto.projectManagerEmployeeId ?? null,
            ...(dto.division !== undefined ? { division: dto.division } : {}),
            departmentType: dto.departmentType ?? null,
            projectType: dto.projectType ?? null,
            ...(dto.siteType !== undefined ? { siteType: dto.siteType } : {}),
            isHO: dto.isHO ?? false,
            siteStartDate: dto.siteStartDate
              ? new Date(dto.siteStartDate)
              : null,
            purchaseLimit: dto.purchaseLimit ?? null,
            orderNumber: dto.orderNumber ?? null,
            cgstApplicable: dto.cgstApplicable ?? false,
            description: dto.description ?? null,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.PROJECT,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId: created.companyId,
      ipAddress,
    });
    return created;
  }

  async findAll(
    caller: AuthenticatedUser,
    query: ListProjectsDto,
  ): Promise<ProjectListPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE),
    );

    const where: Prisma.ProjectWhereInput = {
      ...companyScope(caller, query.companyId),
      ...(query.status ? { status: query.status } : {}),
      ...(query.clientId ? { clientId: query.clientId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const [rows, total] = await Promise.all([
        tx.project.findMany({
          where,
          orderBy: { code: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { client: { select: { name: true } } },
        }),
        tx.project.count({ where }),
      ]);

      return {
        items: rows.map((project) => ({
          id: project.id,
          code: project.code,
          name: project.name,
          client: project.client.name,
          location: project.location,
          // Prisma hands back Decimal; JSON consumers want a number.
          contractValue: Number(project.contractValue),
          status: project.status,
          startDate: project.startDate,
          expectedEndDate: project.expectedEndDate,
          isLocked: project.isLocked,
        })),
        total,
        page,
        pageSize,
      };
    });
  }

  /**
   * One project with every tab the detail page shows.
   *
   * The three summaries are computed in this schema. The three lists are not:
   * employees come from HR (real — 005 has shipped), machinery from Plant and
   * materials from Inventory (neither module exists, so both come back empty and the
   * module is named in `unavailableModules`).
   *
   * The cross-module read is a real service call rather than a join. Principle I
   * forbids this module from touching `hr`, and it is also what lets the two summary
   * shapes below be computed without waiting on it.
   */
  async findOne(caller: AuthenticatedUser, id: string): Promise<ProjectDetail> {
    const ctx = rlsContextFor(caller);

    const project = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.project.findUnique({ where: { id } }),
    );
    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }
    assertInScope(caller, project, `Project ${id}`);

    const ownData = await withRlsContext(this.prisma, ctx, async (tx) => {
      const [siteIds, dwrCount, latestDwr, bills, revenues] = await Promise.all(
        [
          tx.site.findMany({
            where: { projectId: id },
            select: { id: true },
          }),
          tx.dailyWorkReport.count({ where: { projectId: id } }),
          tx.dailyWorkReport.findFirst({
            where: { projectId: id },
            orderBy: { workDate: 'desc' },
            select: { workDate: true },
          }),
          tx.rABill.findMany({
            where: { projectId: id },
            select: { amount: true },
          }),
          tx.revenue.findMany({
            where: { projectId: id },
            select: { amount: true, status: true },
          }),
        ],
      );
      return { siteIds, dwrCount, latestDwr, bills, revenues };
    });

    const employees = await this.employees.listActiveBySiteIds(
      ctx,
      ownData.siteIds.map((site) => site.id),
    );

    const totalReceived = ownData.revenues
      .filter((row) => row.status === 'received')
      .reduce((sum, row) => sum + Number(row.amount), 0);
    const totalPending = ownData.revenues
      .filter((row) => row.status === 'pending')
      .reduce((sum, row) => sum + Number(row.amount), 0);

    return {
      project,
      tabs: {
        employees,
        machinery: [],
        materials: [],
        dwrSummary: {
          count: ownData.dwrCount,
          latestDate: ownData.latestDwr?.workDate ?? null,
        },
        billSummary: {
          totalBills: ownData.bills.length,
          totalExpenses: ownData.bills.reduce(
            (sum, bill) => sum + Number(bill.amount),
            0,
          ),
        },
        revenueSummary: { totalReceived, totalPending },
      },
      // Named, not silently empty — see the note on ProjectDetail.
      unavailableModules: ['plant', 'inventory'],
    };
  }

  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: UpdateProjectDto,
    ipAddress: string,
  ): Promise<Project> {
    const { before, after } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.project.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException(`Project ${id} not found`);
        }
        assertInScope(caller, existing, `Project ${id}`);

        if (dto.clientId !== undefined) {
          const client = await tx.client.findFirst({
            where: { id: dto.clientId, companyId: existing.companyId },
            select: { id: true },
          });
          if (!client) {
            throw new NotFoundException(`Client ${dto.clientId} not found`);
          }
        }

        const updated = await tx.project.update({
          where: { id },
          data: {
            // Applied field by field so a PATCH cannot blank a column it never
            // mentioned — see ClientsService.update() for the same reasoning.
            ...(dto.code !== undefined ? { code: dto.code.trim() } : {}),
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.clientId !== undefined ? { clientId: dto.clientId } : {}),
            ...(dto.location !== undefined
              ? { location: dto.location || null }
              : {}),
            ...(dto.contractValue !== undefined
              ? { contractValue: dto.contractValue }
              : {}),
            ...(dto.startDate !== undefined
              ? { startDate: new Date(dto.startDate) }
              : {}),
            ...(dto.expectedEndDate !== undefined
              ? {
                  expectedEndDate: dto.expectedEndDate
                    ? new Date(dto.expectedEndDate)
                    : null,
                }
              : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            ...(dto.projectManagerEmployeeId !== undefined
              ? {
                  projectManagerEmployeeId:
                    dto.projectManagerEmployeeId || null,
                }
              : {}),
            ...(dto.division !== undefined ? { division: dto.division } : {}),
            ...(dto.departmentType !== undefined
              ? { departmentType: dto.departmentType || null }
              : {}),
            ...(dto.projectType !== undefined
              ? { projectType: dto.projectType || null }
              : {}),
            ...(dto.siteType !== undefined ? { siteType: dto.siteType } : {}),
            ...(dto.isHO !== undefined ? { isHO: dto.isHO } : {}),
            ...(dto.siteStartDate !== undefined
              ? {
                  siteStartDate: dto.siteStartDate
                    ? new Date(dto.siteStartDate)
                    : null,
                }
              : {}),
            ...(dto.purchaseLimit !== undefined
              ? { purchaseLimit: dto.purchaseLimit }
              : {}),
            ...(dto.orderNumber !== undefined
              ? { orderNumber: dto.orderNumber || null }
              : {}),
            ...(dto.cgstApplicable !== undefined
              ? { cgstApplicable: dto.cgstApplicable }
              : {}),
            ...(dto.description !== undefined
              ? { description: dto.description || null }
              : {}),
            ...(dto.isLocked !== undefined ? { isLocked: dto.isLocked } : {}),
          },
        });
        return { before: existing, after: updated };
      },
    );

    // The lock transition is recorded with its before/after, not just as "updated"
    // (contracts/projects-api.md). Freezing a project stops every other user from
    // entering data, so who did it and when is the one thing an auditor will look
    // for — and a bare UPDATE entry would not answer it.
    await this.auditLog.record({
      entityType: AuditEntityType.PROJECT,
      action: AuditAction.UPDATE,
      entityId: after.id,
      accountId: caller.id,
      companyId: after.companyId,
      ipAddress,
      changes:
        before.isLocked !== after.isLocked
          ? { isLocked: { before: before.isLocked, after: after.isLocked } }
          : { fields: Object.keys(dto) },
    });
    return after;
  }

  /**
   * Removes a project nothing has been recorded against.
   *
   * Refused once any of the four exists, because deleting the parent would cascade
   * them away — `BOQTaskGroup`, `DailyWorkReport`, `Revenue` and `RABill` all
   * cascade from Project — and a cascade that silently destroys approved bills is
   * not a delete anyone intended. Sites do not block: they are `SetNull`, so they
   * survive the project and keep working for attendance.
   */
  async remove(
    caller: AuthenticatedUser,
    id: string,
    ipAddress: string,
  ): Promise<{ id: string }> {
    const removed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.project.findUnique({
          where: { id },
          include: {
            _count: {
              select: {
                dailyWorkReports: true,
                revenues: true,
                raBills: true,
                boqTaskGroups: true,
              },
            },
          },
        });
        if (!existing) {
          throw new NotFoundException(`Project ${id} not found`);
        }
        assertInScope(caller, existing, `Project ${id}`);

        const blockers = [
          ['work report', existing._count.dailyWorkReports],
          ['revenue entry', existing._count.revenues],
          ['RA bill', existing._count.raBills],
          ['BOQ group', existing._count.boqTaskGroups],
        ].filter(([, count]) => (count as number) > 0);

        if (blockers.length > 0) {
          throw new ConflictException(
            `Project "${existing.name}" cannot be deleted: it has ` +
              blockers
                .map(([label, count]) => `${count} ${label}(s)`)
                .join(', ') +
              '. Set its status to completed instead.',
          );
        }

        await tx.project.delete({ where: { id } });
        return existing;
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.PROJECT,
      action: AuditAction.DELETE,
      entityId: removed.id,
      accountId: caller.id,
      companyId: removed.companyId,
      ipAddress,
    });
    return { id: removed.id };
  }

  // ── Outward contract for other modules ─────────────────────────────────────
  // Written as stubs by 007, which needed them before this feature existed. Two are
  // now real; the third stays a stub because work orders are User Story 6.

  /**
   * Whether the Project Portfolio actually exists yet.
   *
   * True from 008 US3 onwards. Consumers use it to tell "this company has no
   * projects" from "the module that would know has not been built" — two situations
   * that demand completely different things on screen.
   */
  isPortfolioAvailable(): boolean {
    return true;
  }

  /** Projects with a contract value, for BOCW cess liability (007 FR-008). */
  async getProjectsWithContractValues(
    companyId: string,
  ): Promise<ProjectContractValue[]> {
    const rows = await withRlsContext(
      this.prisma,
      { isSuperAdmin: false, companyId },
      (tx) =>
        tx.project.findMany({
          where: { companyId },
          select: { id: true, name: true, contractValue: true },
          orderBy: { code: 'asc' },
        }),
    );
    return rows.map((row) => ({
      projectId: row.id,
      name: row.name,
      contractValue: Number(row.contractValue),
    }));
  }

  /**
   * Total value of work orders raised against a project, for subcontractor cost in
   * the Project P&L (007 FR-009).
   *
   * Still 0: `WorkOrder` now has a table, but nothing writes to it until User Story
   * 6 ships the endpoints. Returning 0 means a P&L built today understates
   * subcontractor cost rather than failing — and the caller must say so rather than
   * presenting 0 as a measured figure.
   */
  async getWorkOrderTotalByProject(
    _projectId: string,
    _range?: { from?: Date; to?: Date },
  ): Promise<number> {
    return 0;
  }
}
