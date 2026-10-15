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
import {
  RlsContext,
  rlsContextFor,
  withRlsContext,
} from '../../common/prisma/rls-context';
import { EmployeesService } from '../../hr/employees/employees.service';
import {
  CODE_SERIES_FORMATS,
  formatCode,
} from '../../settings/code-series/code-series.formats';
import { CodeSeriesService } from '../../settings/code-series/code-series.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { BillPaymentsService } from '../billing/payments/bill-payments.service';
import {
  ProjectDocumentReadiness,
  ProjectDocumentsService,
} from '../documents/project-documents.service';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PROJECT_CODE_INFIX,
} from '../constants/projects.constants';
import { ProjectWorkReference } from '../interfaces/pnl-sources.interface';
import { ProjectSourcesRegistry } from './project-sources.registry';
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
  /**
   * Present only when the caller asked for `include=documentReadiness` (017 FR-008).
   *
   * Optional rather than always computed: readiness costs two extra queries, and the
   * screens that do not show it should not pay for it.
   */
  documentReadiness?: ProjectDocumentReadiness;
}

/**
 * The value of `?include=` that asks for readiness (017 FR-008).
 *
 * A comma-separated list rather than a boolean flag: the list will grow, and
 * `?include=documentReadiness,budget` is the shape that does not need renaming when it
 * does.
 */
export const INCLUDE_DOCUMENT_READINESS = 'documentReadiness';

function wantsReadiness(include?: string): boolean {
  return (include ?? '')
    .split(',')
    .map((part) => part.trim())
    .includes(INCLUDE_DOCUMENT_READINESS);
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
 *
 * As of feature 006 both `plant` and `inventory` are real and the list is normally
 * empty. It is still computed rather than deleted: a module can be absent from a
 * given deployment, and the distinction it draws is the same one it always was.
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
    machinery: {
      id: string;
      code: string;
      name: string;
      status: string;
      deployedSiteId: string | null;
      utilizationPercent: number;
    }[];
    materials: {
      itemId: string;
      itemName: string;
      itemCode: string;
      unit: string;
      issuedQuantity: number;
    }[];
    dwrSummary: { count: number; latestDate: Date | null };
    /**
     * **Subcontractor running-account bills** — `RABill`, the RA bills tab. Money going out.
     *
     * The name is kept as it was found rather than corrected to `subcontractorBillSummary`,
     * because it is a published field and renaming it would break every client that reads it for
     * nothing a comment cannot fix. The label on the screen says which it is, which is where the
     * ambiguity actually bit: a project has a Client bills tab and an RA bills tab, and the
     * overview card said only "Bills".
     *
     * Every status, drafts included — this is "how many bills exist against this project", not
     * "how many have been approved".
     */
    billSummary: {
      totalBills: number;
      totalExpenses: number;
      /**
       * Certified, paid and still owed (2026-10-12).
       *
       * `totalBills`/`totalExpenses` above are everything **raised**, drafts included. These are
       * the money questions, and they are not the same question: a bill is raised when a
       * subcontractor claims, certified when we agree, and paid when it leaves. Derived by
       * `BillPaymentsService.positionForProject`, which is where the rule that certified means
       * `netPayable` on an `approved` bill is written down.
       *
       * Strings, because they are `Decimal` — a project's bills summed as JavaScript numbers leave
       * a fraction of a paisa outstanding on a project that is fully settled.
       */
      certifiedBills: number;
      certifiedAmount: string;
      paidAmount: string;
      outstandingAmount: string;
    };
    /**
     * **Client bills** — `ClientBill`, the Client bills tab. Money coming in (2026-10-12).
     *
     * A separate model from `RABill` and never counted in the figure above, which is why the
     * overview could show six bills booked against a project that had also billed its client
     * several lakh and say nothing about it.
     *
     * `totalBilled` is the sum of `netAmount` — gross less retention, which is what the client is
     * actually asked to pay — and `totalCertified` the sum of what they agreed to. The two are
     * reported separately rather than netted because the variance between them is the thing a
     * project manager chases; a single figure can only say one of them.
     */
    clientBillSummary: {
      totalBills: number;
      totalBilled: number;
      totalCertified: number;
      /** How many of those bills carry a certified figure, so "₹0 certified" is readable. */
      certifiedCount: number;
    };
    /**
     * The project's revenue ledger — **not** client bill receipts (2026-10-12).
     *
     * `Revenue` is a hand-kept list of money received or expected "outside the RA bill process", as
     * its own docblock says, and nothing links a row of it to a client bill. So this is what it has
     * always been, and the screen now labels it as such: a project that has certified ten lakh of
     * client bills still reads ₹0 here if nobody typed a revenue row, and that is not a defect in
     * this figure.
     *
     * **Money received against a client bill is recorded nowhere in this system.** There is no
     * equivalent of `RABillPayment` on the client side. Reporting this ledger as though it were one
     * would be a figure that looks like an answer and is not one.
     */
    revenueSummary: { totalReceived: number; totalPending: number };
  };
  /**
   * How much of the project's paperwork is in (2026-10-11).
   *
   * The same figures the portfolio list already carries, on the one page somebody
   * opens when they want to know what is still outstanding. Until now the overview
   * showed thirteen facts about the project and nothing at all about its documents —
   * the Documents tab had the answer and you had to go and look.
   *
   * `readinessForOne`, not `readinessFor`: the single-project form exists for exactly
   * this, and the list must keep using the batch (the N+1 the contract names).
   */
  documentReadiness: ProjectDocumentReadiness;
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
    // Plant (006) and Inventory (009) announce themselves here rather than being
    // imported: both already import this module to resolve their sites, so a direct
    // import back would make the dependency a five-module cycle. See
    // `ProjectSourcesRegistry` for the whole argument.
    private readonly sources: ProjectSourcesRegistry,
    // 017 US2. Same module, same schema — readiness is this module's own question, and
    // the dashboard asks it through `ProjectDocumentsService`'s exported method rather
    // than by reading the table.
    private readonly documents: ProjectDocumentsService,
    // 2026-10-12. What a subcontractor bill has been certified and paid at is that service's
    // rule, not a second summation written here — see `positionForProject`.
    private readonly billPayments: BillPaymentsService,
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

    // The client is checked **before** the document gate, and the order is the point.
    //
    // Found on 2026-10-04 while repairing the end-to-end suites: with the gate first, a project
    // manager who mistyped a client id was told to attach four mandatory documents, attached
    // them, and was *then* told the client does not exist — four files uploaded for a project
    // that was never going to be created. A cheap, fundamental reference should be refused
    // before work is demanded of the person.
    //
    // This is a pre-flight check, not the authoritative one. The check inside the transaction
    // below stays exactly where it is: it is what makes the write safe against a client deleted
    // between here and there, which this one cannot be.
    const clientExists = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.client.findFirst({
          where: { id: dto.clientId, companyId: targetCompanyId },
          select: { id: true },
        }),
    );
    if (!clientExists) {
      throw new NotFoundException(`Client ${dto.clientId} not found`);
    }

    // 017 FR-009, FR-009a, FR-009c. **Before anything is written.** The gate refuses a creation
    // whose mandatory kinds are not all attached, naming each missing kind's label, and refuses a
    // staged reference the caller may not use. Both checks live in one call so they cannot be
    // applied apart.
    //
    // Returns the staged rows to convert, so the check and the conversion cannot disagree about
    // which references were accepted.
    const stagedDocuments = await this.documents.assertMandatoryKindsSatisfied(
      rlsContextFor(caller),
      targetCompanyId,
      dto.stagedDocumentIds ?? [],
      caller.id,
    );

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
        //
        // Always from the series (2026-10-15). A number already held — a project created
        // with a typed code before the series was enforced — is stepped over rather than
        // refused, so the first project after the switch is not blocked by an old one.
        let code = '';
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          code = await this.codeSeries.next(
            tx,
            targetCompanyId,
            CodeSeriesType.PROJECTS,
            PROJECT_CODE_INFIX,
          );
          const taken = await tx.project.findFirst({
            where: { companyId: targetCompanyId, code },
            select: { id: true },
          });
          if (!taken) break;
        }

        const project = await tx.project.create({
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
            // Left null when unstated, never defaulted to zero: composing a client bill without a
            // retention term is refused by name, and a zero would instead produce a payable five
            // per cent too high that nothing downstream would question (025 FR-019).
            clientRetentionFraction: dto.clientRetentionFraction ?? null,
            description: dto.description ?? null,
          },
        });

        // FR-009e. The conversion and the deletion happen **inside the same transaction** as the
        // project insert, so a failure strands neither a project without its papers nor a staged
        // row that has already been consumed. A reference that cannot be retried is as bad as one
        // that was silently ignored.
        if (stagedDocuments.length > 0) {
          await tx.projectDocument.createMany({
            data: stagedDocuments.map((staged) => ({
              companyId: targetCompanyId,
              projectId: project.id,
              documentType: staged.documentType,
              documentTypeId: staged.documentTypeId,
              fileRef: staged.fileRef,
              filePath: staged.filePath,
              fileName: staged.fileName,
              mimeType: staged.mimeType,
              // Carried over for the same reason `fileName` is: a date typed before the project
              // existed must survive its creation, or the gate accepts a document whose expiry
              // nobody can read afterwards.
              documentNumber: staged.documentNumber,
              expiresAt: staged.expiresAt,
              uploadedByUserId: caller.id,
            })),
          });
          // The blobs are **not** moved or re-uploaded: `fileRef` carries over, so the staged row's
          // deletion must not delete the object it points at. The sweep only removes blobs for rows
          // it also deletes, and a consumed row is gone before the sweep ever sees it.
          await tx.stagedProjectDocument.deleteMany({
            where: { id: { in: stagedDocuments.map((staged) => staged.id) } },
          });
        }

        return project;
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

  /**
   * The code the next project will be given — what the creation form shows in place of a code
   * field (2026-10-15). A preview, not a reservation: the number is drawn when the project is
   * saved, so two people creating at once see the same one and the second gets the next.
   */
  async nextCode(
    caller: AuthenticatedUser,
    companyId?: string,
  ): Promise<{ code: string }> {
    const targetCompanyId = this.targetCompanyOf(caller, companyId);
    const format = CODE_SERIES_FORMATS[CodeSeriesType.PROJECTS];
    return withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const sequence = await tx.codeSequence.findUnique({
        where: {
          companyId_seriesType: {
            companyId: targetCompanyId,
            seriesType: CodeSeriesType.PROJECTS,
          },
        },
        select: { lastNumber: true },
      });
      let n = (sequence?.lastNumber ?? 0) + 1;
      for (;;) {
        const code = format ? formatCode(format, n) : String(n);
        const taken = await tx.project.findFirst({
          where: { companyId: targetCompanyId, code },
          select: { id: true },
        });
        if (!taken) return { code };
        n += 1;
      }
    });
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

    const listed = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
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
          companyIds: rows.map((project) => project.companyId),
        };
      },
    );

    const { companyIds, ...page_ } = listed;
    if (!wantsReadiness(query.include)) return page_;

    // FR-008: readiness in the LIST, without opening each project. Fetched after the
    // transaction above has closed rather than inside it — `withRlsContext` opens a
    // transaction of its own and Prisma cannot nest one.
    //
    // Grouped by company because a cross-company caller's page may span several, and
    // readiness is a per-company question. The cost is two queries per company in the
    // page, never one per project — which is the whole point of the batch form.
    const byCompany = new Map<string, string[]>();
    page_.items.forEach((item, index) => {
      const companyId = companyIds[index];
      byCompany.set(companyId, [...(byCompany.get(companyId) ?? []), item.id]);
    });

    const ctx = rlsContextFor(caller);
    const readiness = new Map<string, ProjectDocumentReadiness>();
    for (const [companyId, projectIds] of byCompany) {
      const forCompany = await this.documents.readinessFor(
        ctx,
        companyId,
        projectIds,
      );
      for (const [projectId, value] of forCompany) {
        readiness.set(projectId, value);
      }
    }

    return {
      ...page_,
      items: page_.items.map((item) => ({
        ...item,
        documentReadiness: readiness.get(item.id),
      })),
    };
  }

  /**
   * One project with every tab the detail page shows.
   *
   * The three summaries are computed in this schema. The three lists are not:
   * employees come from HR, machinery from Plant (006) and materials from Inventory
   * (009). All three are real now; a source that is absent from a deployment comes
   * back empty and is named in `unavailableModules` rather than reported as a
   * measured nothing.
   *
   * Every cross-module read is a service call rather than a join. Principle I forbids
   * this module from touching `hr`, `plant` or `inventory`, and it is also what lets
   * the three summary shapes below be computed without waiting on any of them.
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
      const [siteIds, dwrCount, latestDwr, bills, revenues, clientBills] =
        await Promise.all([
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
          // The other direction (2026-10-12). `netAmount` rather than `grossAmount`: retention is
          // the client's money held back, not a figure they were asked for.
          tx.clientBill.findMany({
            where: { projectId: id },
            select: { netAmount: true, certifiedAmount: true },
          }),
        ]);
      return { siteIds, dwrCount, latestDwr, bills, revenues, clientBills };
    });

    const employees = await this.employees.listActiveBySiteIds(
      ctx,
      ownData.siteIds.map((site) => site.id),
    );

    const [documentReadiness, position] = await Promise.all([
      this.documents.readinessForOne(ctx, project.companyId, id),
      this.billPayments.positionForProject(ctx, id),
    ]);

    const companyId = project.companyId;
    const plant = this.sources.machinerySource();
    const inventory = this.sources.materialsSource();
    const [machinery, materials] = await Promise.all([
      plant ? plant.getMachineryByProject(id, companyId) : null,
      inventory ? inventory.getMaterialsByProject(caller, id, companyId) : null,
    ]);

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
        machinery: machinery ?? [],
        materials: materials ?? [],
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
          certifiedBills: position.certifiedCount,
          certifiedAmount: position.certifiedAmount,
          paidAmount: position.paidAmount,
          outstandingAmount: position.outstandingAmount,
        },
        clientBillSummary: {
          totalBills: ownData.clientBills.length,
          totalBilled: ownData.clientBills.reduce(
            (sum, bill) => sum + Number(bill.netAmount),
            0,
          ),
          // Null is "not certified yet", which is not zero — a bill certified at nil and a bill
          // nobody has looked at are different facts, and only the count tells them apart.
          totalCertified: ownData.clientBills.reduce(
            (sum, bill) => sum + Number(bill.certifiedAmount ?? 0),
            0,
          ),
          certifiedCount: ownData.clientBills.filter(
            (bill) => bill.certifiedAmount !== null,
          ).length,
        },
        revenueSummary: { totalReceived, totalPending },
      },
      documentReadiness,
      // Named, not silently empty — see the note on ProjectDetail. Both are
      // normally present now; the list stays computed so an absent module still
      // reads as "could not ask" rather than as "there is none".
      unavailableModules: [
        ...(machinery === null ? ['plant'] : []),
        ...(materials === null ? ['inventory'] : []),
      ],
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
            ...(dto.clientRetentionFraction !== undefined
              ? { clientRetentionFraction: dto.clientRetentionFraction }
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

  /**
   * Ongoing projects and their combined contract value, per company (Group Dashboard,
   * 2026-10-15).
   *
   * `ongoing` only, the same reading of "active" the company dashboard's Active Projects
   * card takes — a project in planning has nobody on site, and one on hold or completed
   * is not work the company is carrying. One grouped statement for every company.
   */
  async ongoingTotalsByCompany(
    ctx: RlsContext,
    companyIds: string[],
  ): Promise<Map<string, { count: number; contractValue: number }>> {
    if (companyIds.length === 0) return new Map();
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.project.groupBy({
        by: ['companyId'],
        where: {
          companyId: { in: companyIds },
          status: ProjectStatus.ongoing,
        },
        _count: { _all: true },
        _sum: { contractValue: true },
      }),
    );
    return new Map(
      rows.map((r) => [
        r.companyId,
        {
          count: r._count._all,
          contractValue: Number(r._sum.contractValue ?? 0),
        },
      ]),
    );
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

  /**
   * The site ids belonging to a project (009 FR-012).
   *
   * 009's tasks specify this as a stub returning `[]` with a `TODO(008)`, written
   * when 008 had not shipped. It has: `Site.projectId` is a real column with a real
   * index, so this is the actual query rather than a placeholder, and
   * `InventoryService.getMaterialCostByProject()` returns measured figures from the
   * day it lands instead of a zero nobody would notice was fake.
   *
   * Returns `[]` for a project with no sites, which is a legitimate state and not an
   * error: material cost against it is genuinely zero.
   */
  async getSitesByProject(
    projectId: string,
    ctx: RlsContext = { isSuperAdmin: true },
  ): Promise<string[]> {
    const sites = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.site.findMany({
        where: { projectId },
        select: { id: true },
        orderBy: { name: 'asc' },
      }),
    );
    return sites.map((site) => site.id);
  }

  /**
   * A project's identity — code and name — for another module labelling a report or an export
   * (018 FR-010a, FR-011a).
   *
   * `findOne()` exists and is the wrong tool here: it assembles a full project detail with its
   * sites, BOQ and budget, and a caller that only needs a heading would pull all of it. Returns
   * `null` for an unknown id rather than throwing, the contract `getActivityById()` set — the
   * caller is labelling something, not validating access, and the roll-up it headings is already
   * scoped by company.
   */
  async getProjectIdentityById(
    projectId: string,
    ctx: RlsContext = { isSuperAdmin: true },
  ): Promise<{
    id: string;
    code: string;
    name: string;
    companyId: string;
  } | null> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.project.findFirst({
        where: { id: projectId },
        select: { id: true, code: true, name: true, companyId: true },
      }),
    );
  }

  /**
   * A BOQ task group — what the master PRD calls an "Activity" — for another
   * module validating a reference to one (009 FR-019, research.md §13).
   *
   * Returns `null` rather than throwing for an unknown id, the contract
   * `PartnersService.getVendorById()` set: the caller is validating an optional
   * field and wants to report it as invalid, not fail the request outright.
   *
   * The table exists; nothing writes to it until 008's User Story 4 ships the BOQ
   * endpoints. So this returns `null` for every id today, which is the correct
   * answer — an activity that has not been created cannot be issued against.
   */
  async getActivityById(
    activityId: string,
    ctx: RlsContext = { isSuperAdmin: true },
  ): Promise<ProjectWorkReference | null> {
    const group = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.bOQTaskGroup.findUnique({
        where: { id: activityId },
        select: { id: true, name: true, boqNo: true, projectId: true },
      }),
    );
    return group
      ? {
          id: group.id,
          name: group.name,
          reference: group.boqNo,
          projectId: group.projectId,
        }
      : null;
  }

  /** A BOQ task item, with the same null-for-unknown contract as
   * `getActivityById()` above (009 FR-019). */
  async getBoqItemById(
    boqItemId: string,
    ctx: RlsContext = { isSuperAdmin: true },
  ): Promise<ProjectWorkReference | null> {
    const item = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.bOQTaskItem.findUnique({
        where: { id: boqItemId },
        select: {
          id: true,
          taskName: true,
          boqNo: true,
          group: { select: { projectId: true } },
        },
      }),
    );
    return item
      ? {
          id: item.id,
          name: item.taskName,
          reference: item.boqNo,
          projectId: item.group.projectId,
        }
      : null;
  }
}
