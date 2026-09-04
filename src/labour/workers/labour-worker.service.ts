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
  Prisma,
  WorkerStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { assertInScope, companyScope } from '../../settings/company-scope';
import { BiometricsService } from '../../hr/biometrics/biometrics.service';
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
  phone: string;
  skillCategoryId: string;
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
  ) {}

  private toListItem(row: {
    id: string;
    labourCode: string;
    fullName: string;
    phone: string;
    skillCategoryId: string;
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

    const where: Prisma.LabourWorkerWhereInput = {
      ...companyScope(caller, query.companyId),
      deletedAt: null,
      ...(query.siteId ? { siteId: query.siteId } : {}),
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
    return {
      ...this.toListItem(row),
      rateOverride: row.rateOverride ? row.rateOverride.toNumber() : null,
    };
  }

  async create(
    caller: AuthenticatedUser,
    dto: {
      companyId?: string;
      fullName: string;
      phone: string;
      gender: string;
      dateOfBirth: string;
      skillCategoryId: string;
      engagementType: EngagementType;
      contractorId?: string;
      siteId: string;
      aadhaarNumber?: string;
      bankAccount?: string;
      rateOverride?: number;
    },
    ipAddress: string,
  ): Promise<WorkerListItem> {
    const companyId = companyScope(caller, dto.companyId).companyId;
    if (!companyId) {
      throw new NotFoundException('Company not found');
    }

    if (dto.engagementType === EngagementType.contractor) {
      if (!dto.contractorId) {
        throw new BadRequestException(
          'A contractor is required for a contractor-engaged worker',
        );
      }
      await this.refs.assertActiveContractor(caller, dto.contractorId);
    }

    await this.refs.requireSkillCategory(caller, dto.skillCategoryId);

    const created = await withRlsContext(
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
            phone: dto.phone.trim(),
            gender: dto.gender,
            dateOfBirth: new Date(
              `${dto.dateOfBirth.slice(0, 10)}T00:00:00.000Z`,
            ),
            skillCategoryId: dto.skillCategoryId,
            engagementType: dto.engagementType,
            contractorId:
              dto.engagementType === EngagementType.contractor
                ? dto.contractorId
                : null,
            siteId: dto.siteId,
            aadhaarNumber: dto.aadhaarNumber ?? null,
            bankAccount: dto.bankAccount ?? null,
            rateOverride: dto.rateOverride ?? null,
            createdBy: caller.id,
          },
        });
      },
    );

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

    const decoded = photos.map((p, i) =>
      decodePhotoPayload(p, `Enrolment photo ${i + 1}`),
    );
    const compressed = await Promise.all(
      decoded.map((photo) => this.images.compressEnrolmentPhoto(photo)),
    );
    const descriptor = await this.biometrics.computeDescriptor(compressed);
    const serialized = this.biometrics.serializeDescriptor(descriptor);
    const ref = await this.storage.put(
      WORKER_FACE_NAMESPACE,
      serialized,
      'application/octet-stream',
    );

    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.labourWorker.update({
        where: { id },
        data: { faceEnrolmentId: ref },
      }),
    );

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

  private async nextLabourCode(
    tx: Prisma.TransactionClient,
    companyId: string,
  ): Promise<string> {
    const count = await tx.labourWorker.count({ where: { companyId } });
    const next = count + 1;
    return `${LABOUR_CODE_PREFIX}-${String(next).padStart(
      LABOUR_CODE_PAD,
      '0',
    )}`;
  }
}
