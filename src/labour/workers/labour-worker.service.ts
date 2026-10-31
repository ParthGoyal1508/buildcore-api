import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  EngagementType,
  LabourGender,
  LabourPunchType,
  Permission,
  Prisma,
  SiteStatus,
  WorkerStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import {
  assertInScope,
  companyScope,
  resolveCompanyId,
} from '../../settings/company-scope';
import {
  BiometricsService,
  NoFaceDetectedError,
} from '../../hr/biometrics/biometrics.service';
import { ImageProcessingService } from '../../hr/biometrics/image-processing.service';
import { decodePhotoPayload } from '../../hr/biometrics/photo-payload';
import { zonedDateOnly } from '../../hr/leave/leave-days';
import {
  DEFAULT_PAGE_SIZE,
  LABOUR_CODE_PAD,
  LABOUR_CODE_PREFIX,
  LABOUR_WORKER_ERRORS,
  MAX_PAGE_SIZE,
  PII_VISIBLE_CHARS,
  WORKER_FACE_NAMESPACE,
} from '../constants/labour.constants';
import { parseDateOnly } from '../wage-rates/wage-rate.service';
import { planWorkerEdit, WorkerEditInput } from './worker-edit.util';
import { NocsService } from '../../nocs/nocs.service';
import { LabourRefsService } from '../labour-refs.service';
import { SupervisorSiteService } from '../supervisor-sites/supervisor-site.service';

/** Masks a PII string to its last 4 characters (FR-009). Null stays null. */
export function maskPii(value: string | null): string | null {
  if (value === null) return null;
  const visible = value.slice(-PII_VISIBLE_CHARS);
  const hidden = Math.max(value.length - PII_VISIBLE_CHARS, 0);
  return `${'•'.repeat(hidden)}${visible}`;
}

export interface WorkerListItem {
  id: string;
  labourCode: string;
  fullName: string;
  fatherName: string | null;
  gender: LabourGender | null;
  phone: string | null;
  skillCategoryId: string | null;
  engagementType: EngagementType;
  contractorId: string | null;
  /** 052: the contractor's (vendor's) name, null for a direct worker. */
  contractorName: string | null;
  siteId: string;
  status: WorkerStatus;
  aadhaarNumber: string | null;
  bankAccount: string | null;
  faceEnrolled: boolean;
}

/** 052: the detail view — the list item plus what the edit form needs and the site history. */
export interface WorkerDetail extends WorkerListItem {
  rateOverride: number | null;
  dateOfBirth: string | null;
  transfers: {
    fromSiteId: string;
    toSiteId: string;
    transferredOn: string;
    reason: string | null;
  }[];
}

export interface WorkerListPage {
  items: WorkerListItem[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class LabourWorkerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: LabourRefsService,
    private readonly storage: StorageService,
    private readonly biometrics: BiometricsService,
    private readonly images: ImageProcessingService,
    private readonly supervisorSites: SupervisorSiteService,
    private readonly nocs: NocsService,
  ) {}

  private toListItem(
    row: {
      id: string;
      labourCode: string;
      fullName: string;
      fatherName: string | null;
      gender: LabourGender | null;
      phone: string | null;
      skillCategoryId: string | null;
      engagementType: EngagementType;
      contractorId: string | null;
      siteId: string;
      status: WorkerStatus;
      aadhaarNumber: string | null;
      bankAccount: string | null;
      faceEnrolmentId: string | null;
    },
    contractorNames: Map<string, string> = new Map(),
  ): WorkerListItem {
    return {
      id: row.id,
      labourCode: row.labourCode,
      fullName: row.fullName,
      fatherName: row.fatherName,
      gender: row.gender,
      phone: row.phone,
      skillCategoryId: row.skillCategoryId,
      engagementType: row.engagementType,
      contractorId: row.contractorId,
      contractorName: row.contractorId
        ? contractorNames.get(row.contractorId) ?? null
        : null,
      siteId: row.siteId,
      status: row.status,
      aadhaarNumber: maskPii(row.aadhaarNumber),
      bankAccount: maskPii(row.bankAccount),
      faceEnrolled: row.faceEnrolmentId !== null,
    };
  }

  async findAll(
    caller: AuthenticatedUser,
    query: {
      companyId?: string;
      siteId?: string;
      skillCategoryId?: string;
      status?: WorkerStatus;
      search?: string;
      nocStatus?: 'open' | 'closed';
      page?: number;
      pageSize?: number;
    },
  ): Promise<WorkerListPage> {
    const page = Math.max(query.page ?? 1, 1);
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );

    // A supervisor sees labour only at the sites assigned to them (031).
    const allowed = await this.supervisorSites.allowedSiteIds(caller);
    if (query.siteId && allowed !== null && !allowed.includes(query.siteId)) {
      return { items: [], total: 0, page, pageSize };
    }
    const where: Prisma.LabourWorkerWhereInput = {
      ...companyScope(caller, query.companyId),
      deletedAt: null,
      ...(query.siteId
        ? { siteId: query.siteId }
        : allowed !== null
        ? { siteId: { in: allowed } }
        : {}),
      ...(query.skillCategoryId
        ? { skillCategoryId: query.skillCategoryId }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { labourCode: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search } },
              { fatherName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    // 042: the NOC open/closed filter works across the whole register, not the loaded page.
    // The closed set comes from `NocsService` (Principle I), already scoped by RLS, and lands
    // in the same query as the pagination so the counts stay honest.
    if (query.nocStatus) {
      const closed = await this.nocs.closedSubjectIds(caller, 'labour_worker');
      where.id =
        query.nocStatus === 'closed' ? { in: closed } : { notIn: closed };
    }

    const { items, total } = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const [rows, count] = await Promise.all([
          tx.labourWorker.findMany({
            where,
            orderBy: { labourCode: 'asc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          tx.labourWorker.count({ where }),
        ]);
        return { items: rows, total: count };
      },
    );

    const contractorNames = await this.refs.contractorNames(
      caller,
      items.map((row) => row.contractorId),
    );
    return {
      items: items.map((row) => this.toListItem(row, contractorNames)),
      total,
      page,
      pageSize,
    };
  }

  /** Masked worker detail, with what the edit form needs and the site history (052). */
  async findOne(caller: AuthenticatedUser, id: string): Promise<WorkerDetail> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.labourWorker.findUnique({
        where: { id },
        include: { transfers: { orderBy: { createdAt: 'asc' } } },
      }),
    );
    if (!row || row.deletedAt) {
      throw new NotFoundException(`Worker ${id} not found`);
    }
    assertInScope(caller, row, `Worker ${id}`);
    await this.assertSiteVisible(caller, row.siteId, id);
    return this.toDetail(caller, row);
  }

  private async toDetail(
    caller: AuthenticatedUser,
    row: Parameters<LabourWorkerService['toListItem']>[0] & {
      rateOverride: Prisma.Decimal | null;
      dateOfBirth: Date | null;
      transfers?: {
        fromSiteId: string;
        toSiteId: string;
        transferredOn: Date;
        reason: string | null;
      }[];
    },
  ): Promise<WorkerDetail> {
    const contractorNames = await this.refs.contractorNames(caller, [
      row.contractorId,
    ]);
    return {
      ...this.toListItem(row, contractorNames),
      rateOverride: row.rateOverride ? row.rateOverride.toNumber() : null,
      dateOfBirth: row.dateOfBirth
        ? row.dateOfBirth.toISOString().slice(0, 10)
        : null,
      transfers: (row.transfers ?? []).map((t) => ({
        fromSiteId: t.fromSiteId,
        toSiteId: t.toSiteId,
        transferredOn: t.transferredOn.toISOString().slice(0, 10),
        reason: t.reason,
      })),
    };
  }

  /**
   * 052: the active vendors a worker may be engaged through, for the contractor picker. Any active
   * vendor of the company is accepted (FR-008); labour contractors are listed first.
   */
  async contractorOptions(caller: AuthenticatedUser, companyId?: string) {
    return this.refs.contractorOptions(
      caller,
      resolveCompanyId(caller, companyId),
    );
  }

  /**
   * Registers labour (031): name and gender required, father's name and mobile optional, at a
   * site the caller is assigned to. When `photos` come with it, the face template is built first,
   * so a photo with no usable face fails the registration instead of leaving labour on the list
   * who can never be punched in.
   */
  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      fullName: string;
      gender: LabourGender;
      fatherName?: string;
      phone?: string;
      siteId: string;
      photos?: string[];
      dateOfBirth?: string;
      skillCategoryId?: string;
      engagementType?: EngagementType;
      contractorId?: string;
      aadhaarNumber?: string;
      bankAccount?: string;
      rateOverride?: number;
    },
    ipAddress: string,
  ): Promise<WorkerListItem> {
    const companyId = resolveCompanyId(caller, dto.companyId);
    if (dto.rateOverride !== undefined && dto.rateOverride !== null) {
      this.assertMaySetRate(caller);
    }
    await this.supervisorSites.assertSiteAllowed(caller, dto.siteId);
    // 036 O14: the HR office and cross-company callers pass `assertSiteAllowed` for any id, and
    // `LabourWorker.siteId` has no foreign key — so the site is looked up and its company compared,
    // or a worker could be registered at another company's site, or at no site at all.
    const siteCompanyId = await this.refs
      .getSiteCompanyId(caller, dto.siteId)
      .catch(() => null);
    if (siteCompanyId !== companyId) {
      throw new BadRequestException('Site not found in this company');
    }

    const engagementType = dto.engagementType ?? EngagementType.direct;
    if (engagementType === EngagementType.contractor) {
      if (!dto.contractorId) {
        throw new BadRequestException({
          code: LABOUR_WORKER_ERRORS.CONTRACTOR_REQUIRED,
          message: 'A contractor is required for a contractor-engaged worker',
        });
      }
      await this.refs.assertActiveContractor(
        caller,
        dto.contractorId,
        companyId,
      );
    }
    if (dto.skillCategoryId) {
      await this.refs.requireSkillCategory(caller, dto.skillCategoryId);
    }

    const faceEnrolmentId = dto.photos
      ? await this.storeFaceTemplate(dto.photos)
      : null;

    let created;
    try {
      created = await withRlsContext(
        this.prisma,
        rlsContextFor(caller),
        async (tx) => {
          if (dto.aadhaarNumber) {
            const clash = await tx.labourWorker.findFirst({
              where: {
                companyId,
                aadhaarNumber: dto.aadhaarNumber,
                status: WorkerStatus.active,
                deletedAt: null,
              },
            });
            if (clash) {
              throw new ConflictException({
                code: LABOUR_WORKER_ERRORS.AADHAAR_EXISTS,
                message: 'A worker with this Aadhaar already exists',
                existingWorkerId: clash.id,
              });
            }
          }

          const labourCode = await this.nextLabourCode(tx, companyId);

          return tx.labourWorker.create({
            data: {
              companyId,
              labourCode,
              fullName: dto.fullName.trim(),
              fatherName: dto.fatherName?.trim() || null,
              phone: dto.phone?.trim() || null,
              gender: dto.gender,
              dateOfBirth: dto.dateOfBirth
                ? new Date(`${dto.dateOfBirth.slice(0, 10)}T00:00:00.000Z`)
                : null,
              skillCategoryId: dto.skillCategoryId ?? null,
              engagementType,
              contractorId:
                engagementType === EngagementType.contractor
                  ? dto.contractorId
                  : null,
              siteId: dto.siteId,
              aadhaarNumber: dto.aadhaarNumber ?? null,
              bankAccount: dto.bankAccount ?? null,
              rateOverride: dto.rateOverride ?? null,
              faceEnrolmentId,
              createdBy: caller.id,
            },
          });
        },
      );
    } catch (err) {
      if (faceEnrolmentId) {
        await this.storage.delete(faceEnrolmentId).catch(() => undefined);
      }
      throw err;
    }

    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_WORKER,
      action: AuditAction.CREATE,
      entityId: created.id,
      accountId: caller.id,
      companyId,
      ipAddress,
    });
    return this.toListItem(created);
  }

  /**
   * Edits a worker's registration details (052), keeping the labour code, site and face. Validation
   * matches registration: a contractor-engaged worker needs an active contractor of the company,
   * an Aadhaar may not belong to another active worker (409), a skill must exist, and changing the
   * special daily rate needs LABOUR_APPROVE (403) — the permission site rates need.
   *
   * Nothing already priced changes. A payment sheet line keeps the rate, days, gross and contractor
   * it was generated with; the edit reaches a sheet only when one is generated, or a draft
   * regenerated, afterwards — and then for that sheet's whole period, because rates and gender are
   * not dated. Punches and the musters built from them carry no worker detail, so they are as
   * recorded. The audit entry names the changed fields and never their values.
   */
  async update(
    caller: AuthenticatedUser,
    id: string,
    dto: WorkerEditInput,
    ipAddress: string,
  ): Promise<WorkerDetail> {
    const existing = await this.loadForWrite(caller, id);
    const { next, changed } = planWorkerEdit(existing, dto);
    if (changed.length === 0) {
      return this.toDetail(caller, existing);
    }

    if (changed.includes('rateOverride')) this.assertMaySetRate(caller);
    if (next.engagementType === EngagementType.contractor) {
      if (!next.contractorId) {
        throw new BadRequestException({
          code: LABOUR_WORKER_ERRORS.CONTRACTOR_REQUIRED,
          message: 'A contractor is required for a contractor-engaged worker',
        });
      }
      // A contractor already on the record is not re-checked: one since made inactive should not
      // stop somebody correcting the worker's mobile number.
      if (changed.includes('contractorId')) {
        await this.refs.assertActiveContractor(
          caller,
          next.contractorId,
          existing.companyId,
        );
      }
    }
    if (changed.includes('skillCategoryId') && next.skillCategoryId) {
      await this.refs.requireSkillCategory(caller, next.skillCategoryId);
    }

    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        if (changed.includes('aadhaarNumber') && next.aadhaarNumber) {
          const clash = await tx.labourWorker.findFirst({
            where: {
              companyId: existing.companyId,
              aadhaarNumber: next.aadhaarNumber,
              status: WorkerStatus.active,
              deletedAt: null,
              id: { not: id },
            },
          });
          if (clash) {
            throw new ConflictException({
              code: LABOUR_WORKER_ERRORS.AADHAAR_EXISTS,
              message: 'A worker with this Aadhaar already exists',
              existingWorkerId: clash.id,
            });
          }
        }
        return tx.labourWorker.update({
          where: { id },
          data: Object.fromEntries(
            changed.map((field) => [field, next[field]]),
          ),
          include: { transfers: { orderBy: { createdAt: 'asc' } } },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_WORKER,
      action: AuditAction.UPDATE,
      entityId: id,
      accountId: caller.id,
      companyId: existing.companyId,
      ipAddress,
      changes: { fields: changed },
    });
    return this.toDetail(caller, updated);
  }

  /**
   * Moves an active worker to another active site of the same company (052). The caller must be
   * able to work at both sites. From today the worker is listed and punched at the new site; the
   * days already recorded stay with the old site's musters and payment sheets, because attendance
   * belongs to the site it was punched at. The face template moves with the worker, and any gang
   * membership is ended — gangs belong to a site. Refused while the worker is punched in and not
   * yet out, so a day never starts at one site and ends at another. The move is kept as history.
   */
  async transfer(
    caller: AuthenticatedUser,
    id: string,
    dto: { siteId: string; reason?: string },
    ipAddress: string,
  ): Promise<WorkerDetail> {
    const worker = await this.loadForWrite(caller, id);
    if (worker.status !== WorkerStatus.active) {
      throw new BadRequestException({
        code: LABOUR_WORKER_ERRORS.TRANSFER_WORKER_INACTIVE,
        message: `${worker.fullName} is not active, so cannot be transferred.`,
      });
    }
    if (dto.siteId === worker.siteId) {
      throw new BadRequestException({
        code: LABOUR_WORKER_ERRORS.TRANSFER_SAME_SITE,
        message: `${worker.fullName} is already at this site.`,
      });
    }
    // `LabourWorker.siteId` has no foreign key, so the target is looked up and its company
    // compared, as registration does (036 O14).
    const site = await this.refs.findSite(caller, dto.siteId);
    if (!site || site.companyId !== worker.companyId) {
      throw new BadRequestException({
        code: LABOUR_WORKER_ERRORS.TRANSFER_SITE_NOT_FOUND,
        message: 'Site not found in this company',
      });
    }
    if (site.status !== SiteStatus.active) {
      throw new BadRequestException({
        code: LABOUR_WORKER_ERRORS.TRANSFER_SITE_INACTIVE,
        message: `${site.name} is inactive. Labour can only be moved to an active site.`,
      });
    }
    await this.supervisorSites.assertSiteAllowed(caller, dto.siteId);

    const today = zonedDateOnly(new Date(), this.refs.timeZone);
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        // The worker's latest punch: an "in" from today or last night is a day still open.
        const last = await tx.labourPunch.findFirst({
          where: { workerId: id },
          orderBy: { punchedAt: 'desc' },
        });
        const yesterday = new Date(parseDateOnly(today).getTime() - 86_400_000);
        if (
          last &&
          last.type === LabourPunchType.in &&
          last.punchDate >= yesterday
        ) {
          throw new ConflictException({
            code: LABOUR_WORKER_ERRORS.TRANSFER_ON_SITE,
            message: `${worker.fullName} is punched in and not yet out. Punch them out at the current site first.`,
          });
        }
        await tx.gangMember.updateMany({
          where: { workerId: id, isActive: true },
          data: { isActive: false },
        });
        await tx.labourWorkerTransfer.create({
          data: {
            companyId: worker.companyId,
            workerId: id,
            fromSiteId: worker.siteId,
            toSiteId: dto.siteId,
            transferredOn: parseDateOnly(today),
            reason: dto.reason?.trim() || null,
            createdBy: caller.id,
          },
        });
        return tx.labourWorker.update({
          where: { id },
          data: { siteId: dto.siteId },
          include: { transfers: { orderBy: { createdAt: 'asc' } } },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_WORKER,
      action: AuditAction.UPDATE,
      entityId: id,
      accountId: caller.id,
      companyId: worker.companyId,
      ipAddress,
      changes: {
        fields: ['siteId'],
        fromSiteId: worker.siteId,
        toSiteId: dto.siteId,
      },
    });
    return this.toDetail(caller, updated);
  }

  /** A worker the caller may change: in scope and at a site the caller is assigned to. */
  private async loadForWrite(caller: AuthenticatedUser, id: string) {
    const worker = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourWorker.findUnique({
          where: { id },
          include: { transfers: { orderBy: { createdAt: 'asc' } } },
        }),
    );
    if (!worker || worker.deletedAt) {
      throw new NotFoundException(`Worker ${id} not found`);
    }
    assertInScope(caller, worker, `Worker ${id}`);
    await this.supervisorSites.assertSiteAllowed(caller, worker.siteId);
    return worker;
  }

  /**
   * A special daily rate overrides the site rate HR sets, so setting, changing or clearing one
   * needs LABOUR_APPROVE — the permission site rates need (052). A site supervisor can register
   * and correct labour, but not price them.
   */
  private assertMaySetRate(caller: AuthenticatedUser): void {
    if (!caller.permissions.includes(Permission.LABOUR_APPROVE)) {
      throw new ForbiddenException({
        code: LABOUR_WORKER_ERRORS.RATE_NEEDS_APPROVE,
        message:
          'Only someone who can approve labour (who sets site rates) can set a special daily rate.',
      });
    }
  }

  /**
   * Deactivates a worker (FR of US2): sets `lastWorkingDate` and reason, removes them
   * from any gang, and excludes them from future musters while leaving historical
   * rows intact. Succeeds even with unsettled payment lines — those surface as a
   * `settlementPending` flag in the payment report rather than blocking here.
   */
  async deactivate(
    caller: AuthenticatedUser,
    id: string,
    dto: { reason: string; lastWorkingDate: string },
    ipAddress: string,
  ): Promise<WorkerListItem> {
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        const existing = await tx.labourWorker.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) {
          throw new NotFoundException(`Worker ${id} not found`);
        }
        assertInScope(caller, existing, `Worker ${id}`);
        await this.supervisorSites.assertSiteAllowed(caller, existing.siteId);

        await tx.gangMember.updateMany({
          where: { workerId: id, isActive: true },
          data: { isActive: false },
        });

        return tx.labourWorker.update({
          where: { id },
          data: {
            status: WorkerStatus.inactive,
            lastWorkingDate: new Date(
              `${dto.lastWorkingDate.slice(0, 10)}T00:00:00.000Z`,
            ),
            deactivationReason: dto.reason,
          },
        });
      },
    );

    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_WORKER,
      action: AuditAction.UPDATE,
      entityId: id,
      accountId: caller.id,
      companyId: updated.companyId,
      ipAddress,
    });
    return this.toListItem(updated);
  }

  /**
   * Enrols a worker's face, reusing feature 003's biometric machinery unchanged
   * (FR-011): the same descriptor computation, image compression, and encrypted
   * storage. The serialized descriptor is stored as an encrypted blob and its
   * reference kept on the worker; the muster capture compares against it advisorily.
   */
  async enrolFace(
    caller: AuthenticatedUser,
    id: string,
    photos: string[],
    ipAddress: string,
  ): Promise<{ faceEnrolled: true }> {
    const worker = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) => tx.labourWorker.findUnique({ where: { id } }),
    );
    if (!worker || worker.deletedAt) {
      throw new NotFoundException(`Worker ${id} not found`);
    }
    assertInScope(caller, worker, `Worker ${id}`);

    await this.supervisorSites.assertSiteAllowed(caller, worker.siteId);

    const ref = await this.storeFaceTemplate(photos);
    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.labourWorker.update({
        where: { id },
        data: { faceEnrolmentId: ref },
      }),
    );
    // The replaced template is unreachable from here on.
    if (worker.faceEnrolmentId) {
      await this.storage.delete(worker.faceEnrolmentId).catch(() => undefined);
    }

    await this.auditLog.record({
      entityType: AuditEntityType.LABOUR_WORKER,
      action: AuditAction.UPDATE,
      entityId: id,
      accountId: caller.id,
      companyId: worker.companyId,
      ipAddress,
    });
    return { faceEnrolled: true };
  }

  /** Guards a skill-category delete: 409 while any active or historical worker
   * references it (FR-003). Called by the skill-category controller. */
  async assertSkillCategoryUnused(
    caller: AuthenticatedUser,
    skillCategoryId: string,
  ): Promise<void> {
    const count = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.labourWorker.count({
          where: { skillCategoryId, deletedAt: null },
        }),
    );
    if (count > 0) {
      throw new ConflictException(
        'This skill category is referenced by labour workers and cannot be deleted',
      );
    }
  }

  /**
   * Builds the averaged face template from 3–5 photos and stores it encrypted, returning its ref.
   * Every photo must show a detectable face; the descriptor computation rejects one that does not.
   */
  private async storeFaceTemplate(photos: string[]): Promise<string> {
    const decoded = photos.map((p, i) =>
      decodePhotoPayload(p, `Face photo ${i + 1}`),
    );
    const compressed = await Promise.all(
      decoded.map((photo) => this.images.compressEnrolmentPhoto(photo)),
    );
    let descriptor: Float32Array;
    try {
      descriptor = await this.biometrics.computeDescriptor(compressed);
    } catch (error) {
      if (error instanceof NoFaceDetectedError) {
        throw new BadRequestException({
          code: 'LABOUR_FACE_NOT_DETECTED',
          message: `${error.message} Retake it in good light with the face filling the frame.`,
        });
      }
      throw error;
    }
    return this.storage.put(
      WORKER_FACE_NAMESPACE,
      this.biometrics.serializeDescriptor(descriptor),
      'application/octet-stream',
    );
  }

  private async assertSiteVisible(
    caller: AuthenticatedUser,
    siteId: string,
    id: string,
  ): Promise<void> {
    const allowed = await this.supervisorSites.allowedSiteIds(caller);
    if (allowed !== null && !allowed.includes(siteId)) {
      throw new NotFoundException(`Worker ${id} not found`);
    }
  }

  /**
   * The next code from the company's counter (031). `count()+1` handed two simultaneous
   * registrations the same code, and reused a number once anyone was deleted. The first call for a
   * company seeds the counter past the highest code already issued.
   */
  private async nextLabourCode(
    tx: Prisma.TransactionClient,
    companyId: string,
  ): Promise<string> {
    const [{ lastNumber }] = await tx.$queryRaw<{ lastNumber: number }[]>`
      INSERT INTO "labour"."LabourCodeSequence" ("companyId", "lastNumber")
      VALUES (
        ${companyId},
        (SELECT COALESCE(MAX(NULLIF(regexp_replace("labourCode", '[^0-9]', '', 'g'), '')::int), 0) + 1
           FROM "labour"."LabourWorker" WHERE "companyId" = ${companyId})
      )
      ON CONFLICT ("companyId")
      DO UPDATE SET "lastNumber" = "labour"."LabourCodeSequence"."lastNumber" + 1
      RETURNING "lastNumber"`;
    return `${LABOUR_CODE_PREFIX}-${String(lastNumber).padStart(
      LABOUR_CODE_PAD,
      '0',
    )}`;
  }
}
