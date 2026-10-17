import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  EngagementType,
  LabourGender,
  Prisma,
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
import {
  DEFAULT_PAGE_SIZE,
  LABOUR_CODE_PAD,
  LABOUR_CODE_PREFIX,
  MAX_PAGE_SIZE,
  PII_VISIBLE_CHARS,
  WORKER_FACE_NAMESPACE,
} from '../constants/labour.constants';
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
  siteId: string;
  status: WorkerStatus;
  aadhaarNumber: string | null;
  bankAccount: string | null;
  faceEnrolled: boolean;
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
  ) {}

  private toListItem(row: {
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
  }): WorkerListItem {
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

    return {
      items: items.map((row) => this.toListItem(row)),
      total,
      page,
      pageSize,
    };
  }

  /** Masked worker detail. */
  async findOne(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<WorkerListItem & { rateOverride: number | null }> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.labourWorker.findUnique({ where: { id } }),
    );
    if (!row || row.deletedAt) {
      throw new NotFoundException(`Worker ${id} not found`);
    }
    assertInScope(caller, row, `Worker ${id}`);
    await this.assertSiteVisible(caller, row.siteId, id);
    return {
      ...this.toListItem(row),
      rateOverride: row.rateOverride ? row.rateOverride.toNumber() : null,
    };
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
        throw new BadRequestException(
          'A contractor is required for a contractor-engaged worker',
        );
      }
      await this.refs.assertActiveContractor(caller, dto.contractorId);
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
