import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  MusterStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { LabourRefsService } from '../labour-refs.service';
import { SiteWageRateService } from '../site-rates/site-wage-rate.service';
import { LabourDayService } from '../attendance/labour-day.service';

/**
 * Muster rolls: since 031 they are written by face punches (`LabourPunchService`) and only read
 * here. The manual capture routes (open, mark, gang bulk-add, submit, offline capture) were
 * removed with the wizard they served; approval stays for rolls captured before 031.
 */
@Injectable()
export class MusterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: LabourRefsService,
    private readonly siteRates: SiteWageRateService,
    private readonly days: LabourDayService,
  ) {}

  // ── Approval (US4) ──────────────────────────────────────────────────────────

  async findAll(
    caller: AuthenticatedUser,
    query: {
      companyId?: string;
      status?: MusterStatus;
      siteId?: string;
      flagged?: boolean;
    },
  ) {
    const where: Prisma.MusterRollWhereInput = {
      ...companyScope(caller, query.companyId),
      deletedAt: null,
      status: query.status ?? MusterStatus.submitted,
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.flagged
        ? { OR: [{ geofenceViolation: true }, { lowGpsAccuracy: true }] }
        : {}),
    };

    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.musterRoll.findMany({
          where,
          orderBy: { date: 'asc' },
          include: {
            _count: { select: { lines: true } },
            lines: { select: { faceMatchLow: true } },
          },
        }),
    );

    // 036 O8: names beside the ids. Additive.
    const siteNames = await this.refs.siteNames(
      caller,
      rows.map((r) => r.siteId),
    );
    const people = await this.refs.userNames(rows.map((r) => r.supervisorId));
    return rows.map((row) => ({
      id: row.id,
      siteId: row.siteId,
      siteName: siteNames.get(row.siteId) ?? null,
      date: row.date.toISOString().slice(0, 10),
      supervisorId: row.supervisorId,
      supervisorName: people.get(row.supervisorId) ?? null,
      source: row.source,
      status: row.status,
      lineCount: row._count.lines,
      geofenceViolation: row.geofenceViolation,
      lowGpsAccuracy: row.lowGpsAccuracy,
      faceMatchLowCount: row.lines.filter((l) => l.faceMatchLow).length,
    }));
  }

  async findOne(caller: AuthenticatedUser, id: string) {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.musterRoll.findUnique({
        where: { id },
        include: { lines: true },
      }),
    );
    if (!row || row.deletedAt) {
      throw new NotFoundException(`Muster ${id} not found`);
    }
    assertInScope(caller, row, `Muster ${id}`);

    const projectId = await this.refs
      .getSiteProjectId(caller, row.siteId)
      .catch(() => null);

    const lines = await Promise.all(
      row.lines.map(async (line) => {
        const worker = await withRlsContext(
          this.prisma,
          rlsContextFor(caller),
          (tx) =>
            tx.labourWorker.findUnique({
              where: { id: line.workerId },
              select: {
                rateOverride: true,
                gender: true,
                fullName: true,
                labourCode: true,
                contractorId: true,
              },
            }),
        );
        const resolved = await withRlsContext(
          this.prisma,
          rlsContextFor(caller),
          (tx) =>
            this.siteRates.resolveDayRate(caller, tx, {
              rateOverride: worker?.rateOverride
                ? worker.rateOverride.toNumber()
                : null,
              gender: worker?.gender ?? null,
              siteId: row.siteId,
              projectId,
              skillCategoryIdOnDay: line.skillCategoryIdOnDay,
              date: row.date,
            }),
        );
        const applicableRate = resolved?.rate ?? null;
        return {
          id: line.id,
          workerId: line.workerId,
          workerName: worker?.fullName ?? null,
          labourCode: worker?.labourCode ?? null,
          contractorId: worker?.contractorId ?? null,
          attendanceType: line.attendanceType,
          overtimeHours: line.overtimeHours
            ? line.overtimeHours.toNumber()
            : null,
          photoRef: line.photoRef,
          faceMatchScore: line.faceMatchScore
            ? line.faceMatchScore.toNumber()
            : null,
          faceMatchLow: line.faceMatchLow,
          skillCategoryIdOnDay: line.skillCategoryIdOnDay,
          applicableRate,
        };
      }),
    );

    // 036 O8: names beside the ids. Additive.
    const [siteNames, people, contractors, skills] = await Promise.all([
      this.refs.siteNames(caller, [row.siteId]),
      this.refs.userNames([row.supervisorId, row.approvedBy]),
      this.refs.contractorNames(
        caller,
        lines.map((l) => l.contractorId),
      ),
      this.refs.skillCategoryNames(
        caller,
        lines.map((l) => l.skillCategoryIdOnDay),
      ),
    ]);

    return {
      id: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      siteName: siteNames.get(row.siteId) ?? null,
      projectId,
      date: row.date.toISOString().slice(0, 10),
      supervisorId: row.supervisorId,
      supervisorName: people.get(row.supervisorId) ?? null,
      approvedByName: row.approvedBy
        ? people.get(row.approvedBy) ?? null
        : null,
      latitude: row.latitude.toNumber(),
      longitude: row.longitude.toNumber(),
      accuracyMetres: row.accuracyMetres.toNumber(),
      geofenceViolation: row.geofenceViolation,
      lowGpsAccuracy: row.lowGpsAccuracy,
      distanceFromFenceMetres: row.distanceFromFenceMetres
        ? row.distanceFromFenceMetres.toNumber()
        : null,
      isOfflineSynced: row.isOfflineSynced,
      capturedAt: row.capturedAt.toISOString(),
      status: row.status,
      approvedBy: row.approvedBy,
      returnReason: row.returnReason,
      lines: lines.map((l) => ({
        ...l,
        contractorName: l.contractorId
          ? contractors.get(l.contractorId) ?? null
          : null,
        skillCategoryName: l.skillCategoryIdOnDay
          ? skills.get(l.skillCategoryIdOnDay) ?? null
          : null,
      })),
    };
  }

  async approve(caller: AuthenticatedUser, id: string, ipAddress: string) {
    // The muster's own company for the audit row, not the caller's home company: a Super Admin
    // working in a selected company would otherwise file it under the wrong one (036 3e, 2026-10-17).
    let companyId: string | null = null;
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const muster = await tx.musterRoll.findUnique({ where: { id } });
      if (!muster || muster.deletedAt) {
        throw new NotFoundException(`Muster ${id} not found`);
      }
      assertInScope(caller, muster, `Muster ${id}`);
      companyId = muster.companyId;
      if (muster.status !== MusterStatus.submitted) {
        throw new ConflictException('Only a submitted muster can be approved');
      }
      // 036 O4: a sheet covering the date has already been priced without this muster, and no
      // later sheet may overlap it — approving now would leave the day never paid.
      await this.days.assertNotOnPaymentSheet(tx, {
        companyId: muster.companyId,
        siteId: muster.siteId,
        punchDate: muster.date,
      });
      await tx.musterRoll.update({
        where: { id },
        data: {
          status: MusterStatus.approved,
          approvedBy: caller.id,
          approvedAt: new Date(),
        },
      });
    });
    await this.audit(
      AuditAction.UPDATE,
      id,
      companyId,
      caller,
      ipAddress,
    );
    return this.findOne(caller, id);
  }

  async returnToDraft(
    caller: AuthenticatedUser,
    id: string,
    reason: string,
    ipAddress: string,
  ) {
    // The muster's own company for the audit row, not the caller's home company: a Super Admin
    // working in a selected company would otherwise file it under the wrong one (036 3e, 2026-10-17).
    let companyId: string | null = null;
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const muster = await tx.musterRoll.findUnique({ where: { id } });
      if (!muster || muster.deletedAt) {
        throw new NotFoundException(`Muster ${id} not found`);
      }
      assertInScope(caller, muster, `Muster ${id}`);
      companyId = muster.companyId;
      if (muster.status !== MusterStatus.submitted) {
        throw new ConflictException('Only a submitted muster can be returned');
      }
      await tx.musterRoll.update({
        where: { id },
        data: { status: MusterStatus.draft, returnReason: reason },
      });
    });
    await this.audit(
      AuditAction.UPDATE,
      id,
      companyId,
      caller,
      ipAddress,
    );
    return this.findOne(caller, id);
  }

  private async audit(
    action: AuditAction,
    entityId: string,
    companyId: string | null,
    caller: AuthenticatedUser,
    ipAddress: string,
  ) {
    await this.auditLog.record({
      entityType: AuditEntityType.MUSTER_ROLL,
      action,
      entityId,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
  }
}
