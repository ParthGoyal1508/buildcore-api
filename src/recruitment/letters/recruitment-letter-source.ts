import { Injectable, OnModuleInit } from '@nestjs/common';
import { OfferStatus, Prisma, ResignationStatus } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { rupeesFirstInWords } from '../../common/rupees-in-words';
import { employeeNameOf } from '../../hr/employee-name';
import { LetterRecordSources } from '../../letters/letter-record-sources';
import { ProjectsService } from '../../projects/portfolio/projects.service';
import { SitesService } from '../../projects/sites/sites.service';
import { RecruitmentRefsService } from '../recruitment-refs.service';

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * What `recruitment` contributes to a letter's records (2026-10-13).
 *
 * Two contributions, registered into `LetterRecordSources` on init:
 *
 * - **The `candidate` record** — the candidate as entered, and their latest offer. The
 *   offer letter is written before there is an employee, so this is the only record it has.
 * - **The resignation half of the `employee` record.** `hr` builds the rest; the
 *   resignation is this module's table, and `hr` cannot ask for it because this module
 *   already imports `hr`. The registry merges the two, so a relieving letter's
 *   `resignation.date` and its `designation` arrive in one record without either module
 *   knowing about the other's part.
 *
 * Names of designations, departments and the reporting manager go through
 * `RecruitmentRefsService`, the module's one seam onto `hr` and `settings`; the place of
 * posting through `projects`' services. Nothing here reads another schema.
 */
@Injectable()
export class RecruitmentLetterSource implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: LetterRecordSources,
    private readonly refs: RecruitmentRefsService,
    private readonly sites: SitesService,
    private readonly projects: ProjectsService,
  ) {}

  onModuleInit(): void {
    this.sources.register('candidate', (caller, id) =>
      this.candidateRecord(caller, id),
    );
    this.sources.register('employee', (caller, id) =>
      this.resignationContribution(caller, id),
    );
  }

  /**
   * The `candidate` record: who they are, and the terms of their latest offer.
   *
   * `offer.ctc` is the **annual** offered CTC, as the offer records it (`offeredCtc`, which
   * the salary breakup reconciles at one twelfth a month); `offer.ctcMonthly` is that
   * twelfth. A superseded offer is skipped — it is the one the candidate was not given.
   */
  async candidateRecord(
    caller: AuthenticatedUser,
    candidateId: string,
  ): Promise<Record<string, unknown> | null> {
    const ctx = rlsContextFor(caller);
    const found = await withRlsContext(this.prisma, ctx, async (tx) => {
      const candidate = await tx.candidate.findFirst({
        where: { id: candidateId, deletedAt: null },
        include: { requisition: { select: { siteId: true, projectId: true } } },
      });
      if (!candidate) return null;
      const offer = await tx.offer.findFirst({
        where: {
          candidateId,
          deletedAt: null,
          status: { not: OfferStatus.superseded },
        },
        orderBy: { createdAt: 'desc' },
      });
      return { candidate, offer };
    });
    if (!found) return null;
    const { candidate, offer } = found;

    const record: Record<string, unknown> = {
      fullName: candidate.fullName,
      fatherName: candidate.fatherName,
      address: candidate.address,
      phone: candidate.phone,
      email: candidate.email,
    };
    if (!offer) return record;

    const [designation, department, manager, placeOfPosting] =
      await Promise.all([
        this.refs.designationName(caller, offer.designationId),
        this.refs.departmentName(caller, offer.departmentId),
        this.refs
          .getEmployee(caller, offer.reportingManagerEmployeeId)
          .catch(() => null),
        this.placeOfPosting(
          ctx,
          candidate.requisition.siteId,
          candidate.requisition.projectId,
        ),
      ]);

    const annual = offer.offeredCtc.toNumber();
    record.offer = {
      designation,
      department,
      joiningDate: offer.confirmedJoiningDate ?? offer.proposedJoiningDate,
      ctc: new Prisma.Decimal(round2(annual)),
      ctcMonthly: new Prisma.Decimal(round2(annual / 12)),
      ctcInWords: rupeesFirstInWords(round2(annual)),
      probationMonths: offer.probationMonths,
      noticeDays: offer.noticePeriodDays,
      reportingManager: manager ? employeeNameOf(manager) ?? '' : '',
      reportingManagerMobile: manager?.mobile ?? '',
      placeOfPosting,
    };
    return record;
  }

  /**
   * `resignation.*` (and the notice days of `fnf.*`) for the employee record.
   *
   * The latest **accepted** resignation: a submitted one is not yet a fact a relieving
   * letter can state, and a withdrawn one never will be. Null when there is none, so the
   * registry contributes nothing rather than an empty section.
   *
   * Notice served is counted from the resignation date to the last working day. Required
   * is what the resignation recorded, which is what the employee's terms said at the time.
   */
  async resignationContribution(
    caller: AuthenticatedUser,
    employeeId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.resignation.findFirst({
        where: {
          employeeId,
          status: ResignationStatus.accepted,
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (!row) return null;
    const lastWorkingDay =
      row.agreedLastWorkingDay ?? row.expectedLastWorkingDay;
    return {
      resignation: {
        date: row.resignationDate,
        lastWorkingDay,
      },
      fnf: {
        noticeRequiredDays: row.noticePeriodDays,
        noticeServedDays: Math.max(
          0,
          Math.round(
            (lastWorkingDay.getTime() - row.resignationDate.getTime()) / DAY_MS,
          ),
        ),
      },
    };
  }

  /** The requisition's project, else its site. `''` when it names neither. */
  private async placeOfPosting(
    ctx: ReturnType<typeof rlsContextFor>,
    siteId: string | null,
    projectId: string | null,
  ): Promise<string> {
    try {
      if (projectId) {
        const project = await this.projects.getProjectIdentityById(
          projectId,
          ctx,
        );
        if (project) return project.name;
      }
      if (siteId) {
        const site = await this.sites.getSiteById(ctx, siteId);
        return site.name;
      }
    } catch {
      // A site deleted since the requisition was raised. HR types the place instead.
    }
    return '';
  }
}
