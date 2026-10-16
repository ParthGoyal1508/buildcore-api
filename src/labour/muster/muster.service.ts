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

    return rows.map((row) => ({
      id: row.id,
      siteId: row.siteId,
      date: row.date.toISOString().slice(0, 10),
      supervisorId: row.supervisorId,
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
              select: { rateOverride: true, gender: true },
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

    return {
      id: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      projectId,
      date: row.date.toISOString().slice(0, 10),
      supervisorId: row.supervisorId,
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
      lines,
    };
  }

  async approve(caller: AuthenticatedUser, id: string, ipAddress: string) {
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const muster = await tx.musterRoll.findUnique({ where: { id } });
      if (!muster || muster.deletedAt) {
        throw new NotFoundException(`Muster ${id} not found`);
      }
      assertInScope(caller, muster, `Muster ${id}`);
      if (muster.status !== MusterStatus.submitted) {
        throw new ConflictException('Only a submitted muster can be approved');
      }
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
      caller.companyId ?? null,
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
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      const muster = await tx.musterRoll.findUnique({ where: { id } });
      if (!muster || muster.deletedAt) {
        throw new NotFoundException(`Muster ${id} not found`);
      }
      assertInScope(caller, muster, `Muster ${id}`);
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
      caller.companyId ?? null,
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
