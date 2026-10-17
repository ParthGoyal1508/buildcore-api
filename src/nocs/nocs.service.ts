import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccessLevel, Permission, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { holdsAtLevel } from '../common/access-levels';
import { rlsContextFor, withRlsContext } from '../common/prisma/rls-context';
import { StorageService } from '../common/storage/storage.service';
import {
  assertAllowedFileType,
  compressImageUpload,
  decodeBase64Upload,
  DOCUMENT_TYPES,
} from '../common/uploads';
import { assertInScope, effectiveCompanyId } from '../settings/company-scope';
import {
  MAX_STATUS_SUBJECTS,
  type ListNocsDto,
  type NocSubject,
  type UploadNocDto,
} from './dto/noc.dto';

/**
 * Where each subject lives, so an upload can be refused for a record that does not exist in the
 * caller's company (036 B16). Before this, any string was accepted as `subjectId`, and a NOC could
 * be filed against nothing — or against another company's record id.
 */
const SUBJECT_TABLE: Record<
  NocSubject,
  (
    tx: Prisma.TransactionClient,
    where: { id: string; companyId: string },
  ) => Promise<{ id: string } | null>
> = {
  work_order: (tx, where) =>
    tx.workOrder.findFirst({ where, select: { id: true } }),
  hire_order: (tx, where) =>
    tx.hireOrder.findFirst({ where, select: { id: true } }),
  labour_worker: (tx, where) =>
    tx.labourWorker.findFirst({ where, select: { id: true } }),
  vendor: (tx, where) => tx.vendor.findFirst({ where, select: { id: true } }),
  employee: (tx, where) =>
    tx.employee.findFirst({ where, select: { id: true } }),
  purchase_order: (tx, where) =>
    tx.issuedLetter.findFirst({ where, select: { id: true } }),
};

/**
 * The permission a NOC's subject is managed under. Reading or uploading a NOC needs the same
 * right as the screen it is attached to, so a NOC is never more visible than its subject.
 */
const SUBJECT_PERMISSION: Record<NocSubject, Permission> = {
  work_order: Permission.PROJECTS,
  hire_order: Permission.MACHINERY,
  labour_worker: Permission.DAILY_WORKER_REGISTRY,
  vendor: Permission.PARTNERS,
  employee: Permission.EMPLOYEES,
  purchase_order: Permission.INVENTORY,
};

/** Every subject area — the controller's outer gate. */
export const NOC_PERMISSIONS: Permission[] = [
  ...new Set(Object.values(SUBJECT_PERMISSION)),
];

/**
 * Whether a record still awaits its NOC (2026-10-17): **open** until one is uploaded, **closed**
 * from then on. Derived from the NOCs on every read rather than stored, so it cannot drift from
 * them — removing the only NOC reopens the record with nothing else to update.
 *
 * A status only: closing blocks nothing, so a late bill or correction can still be entered. It
 * sits beside each record's own lifecycle (a work order's `completed`, an employee's exit) and
 * changes neither.
 */
export type NocStatus = 'open' | 'closed';

export interface NocStatusView {
  subjectId: string;
  status: NocStatus;
  /** When the closing NOC was uploaded; null while open. */
  closedAt: Date | null;
}

/**
 * Whether a NOC closes its record. A work order takes two — one after the LOI and one after the
 * work order — and only the second closes it; the LOI's NOC is a step on the way. A work-order NOC
 * uploaded before stages existed (stage null) is treated as the closing one.
 */
export function nocCloses(row: { subjectType: string; stage: string | null }) {
  return row.subjectType !== 'work_order' || row.stage !== 'loi';
}

export interface NocView {
  id: string;
  subjectType: string;
  subjectId: string;
  stage: string | null;
  fileName: string | null;
  mimeType: string | null;
  issuedBy: string | null;
  referenceNo: string | null;
  issuedOn: string | null;
  remarks: string | null;
  createdAt: Date;
}

/**
 * No Objection Certificates, uploaded against whatever they are about (2026-10-15).
 *
 * The client: "we just need to give an option of uploading No Objection Certificate — in work
 * order, LOI, WO for hire vehicle, NOC for labour, NOC for vendor, NOC for staff". The application
 * does not generate them, so they are numbered by nobody here: the reference is the issuer's own.
 */
@Injectable()
export class NocsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async list(
    caller: AuthenticatedUser,
    query: ListNocsDto,
  ): Promise<NocView[]> {
    this.assertMay(caller, query.subjectType, AccessLevel.read);
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.nocDocument.findMany({
          where: { subjectType: query.subjectType, subjectId: query.subjectId },
          orderBy: { createdAt: 'desc' },
        }),
    );
    return rows.map((row) => this.toView(row));
  }

  /** Open or closed, for each of a page of records of one type. */
  async statuses(
    caller: AuthenticatedUser,
    subjectType: NocSubject,
    subjectIds: string[],
  ): Promise<NocStatusView[]> {
    this.assertMay(caller, subjectType, AccessLevel.read);
    const ids = Array.from(new Set(subjectIds.filter(Boolean)));
    if (ids.length > MAX_STATUS_SUBJECTS) {
      throw new BadRequestException(
        `Ask for at most ${MAX_STATUS_SUBJECTS} records at a time.`,
      );
    }
    if (ids.length === 0) return [];
    const rows = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.nocDocument.findMany({
          where: { subjectType, subjectId: { in: ids } },
          select: {
            subjectType: true,
            subjectId: true,
            stage: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        }),
    );
    const closedAt = new Map<string, Date>();
    for (const row of rows) {
      if (nocCloses(row) && !closedAt.has(row.subjectId)) {
        closedAt.set(row.subjectId, row.createdAt);
      }
    }
    return ids.map((subjectId) => ({
      subjectId,
      status: closedAt.has(subjectId) ? 'closed' : 'open',
      closedAt: closedAt.get(subjectId) ?? null,
    }));
  }

  async upload(caller: AuthenticatedUser, dto: UploadNocDto): Promise<NocView> {
    this.assertMay(caller, dto.subjectType, AccessLevel.write);
    const companyId = effectiveCompanyId(caller);
    if (!companyId) {
      throw new BadRequestException('Choose a company before uploading a NOC.');
    }
    if (dto.stage && dto.subjectType !== 'work_order') {
      throw new BadRequestException('Only a work order NOC names a stage.');
    }
    const subject = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        SUBJECT_TABLE[dto.subjectType](tx, { id: dto.subjectId, companyId }),
    );
    if (!subject) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'NOC_SUBJECT_NOT_FOUND',
        message: 'The record this NOC is for was not found in this company.',
      });
    }

    // The reference implementation of the shared upload pipeline (036 B4, B5, B6): size checked
    // on the decoded file, type decided by the bytes rather than the client's `contentType`, and
    // a photographed certificate compressed before it is stored.
    // TODO(VIRUS_SCAN): stored unscanned, the same gap every document upload here carries.
    const raw = decodeBase64Upload(dto.file, 'The NOC file');
    const detected = assertAllowedFileType(raw, DOCUMENT_TYPES, 'The NOC file');
    const image = await compressImageUpload(raw, detected.contentType);
    const buffer = image?.main.data ?? raw;
    const mimeType = image?.main.contentType ?? detected.contentType;
    // No thumbnail is stored: `NocDocument` has no column for one, and a NOC list shows names,
    // not pictures. A module whose list shows images stores `image.thumbnail` too.
    const fileRef = await this.storage.put('noc-documents', buffer, mimeType);
    const created = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.nocDocument.create({
          data: {
            companyId,
            subjectType: dto.subjectType,
            subjectId: dto.subjectId,
            stage: dto.stage ?? null,
            fileRef,
            fileName: dto.fileName?.trim() || null,
            mimeType,
            issuedBy: dto.issuedBy?.trim() || null,
            referenceNo: dto.referenceNo?.trim() || null,
            issuedOn: dto.issuedOn
              ? new Date(`${dto.issuedOn.slice(0, 10)}T00:00:00.000Z`)
              : null,
            remarks: dto.remarks?.trim() || null,
            uploadedByUserId: caller.id,
          },
        }),
    );
    return this.toView(created);
  }

  async file(
    caller: AuthenticatedUser,
    id: string,
  ): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const row = await this.load(caller, id);
    return {
      buffer: await this.storage.get(row.fileRef),
      fileName: row.fileName ?? `NOC ${row.referenceNo ?? row.id}`,
      mimeType: row.mimeType ?? 'application/octet-stream',
    };
  }

  async remove(caller: AuthenticatedUser, id: string): Promise<void> {
    const row = await this.load(caller, id, AccessLevel.write);
    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.nocDocument.delete({ where: { id: row.id } }),
    );
    // The file goes with its record; a NOC removed by mistake is uploaded again.
    await this.storage.delete(row.fileRef).catch(() => undefined);
  }

  private async load(
    caller: AuthenticatedUser,
    id: string,
    level: AccessLevel = AccessLevel.read,
  ) {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.nocDocument.findUnique({ where: { id } }),
    );
    if (!row) throw new NotFoundException('NOC not found');
    assertInScope(caller, row, 'NOC');
    this.assertMay(caller, row.subjectType as NocSubject, level);
    return row;
  }

  /**
   * The subject's permission **at the level the action needs** (036 B16). It used to check the
   * area alone, so a read-only holder could upload and delete NOCs.
   */
  private assertMay(
    caller: AuthenticatedUser,
    subject: NocSubject,
    level: AccessLevel,
  ) {
    const needed = SUBJECT_PERMISSION[subject];
    if (!needed)
      throw new BadRequestException(`Unknown NOC subject ${subject}`);
    if (!holdsAtLevel(caller, needed, level)) {
      throw new ForbiddenException({
        statusCode: 403,
        code:
          level === AccessLevel.write ? 'NOC_WRITE_FORBIDDEN' : 'NOC_FORBIDDEN',
        message:
          level === AccessLevel.write
            ? 'You can view this record but not change its NOCs.'
            : 'You do not have access to the record this NOC belongs to.',
      });
    }
  }

  private toView(row: {
    id: string;
    subjectType: string;
    subjectId: string;
    stage: string | null;
    fileName: string | null;
    mimeType: string | null;
    issuedBy: string | null;
    referenceNo: string | null;
    issuedOn: Date | null;
    remarks: string | null;
    createdAt: Date;
  }): NocView {
    return {
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      stage: row.stage,
      fileName: row.fileName,
      mimeType: row.mimeType,
      issuedBy: row.issuedBy,
      referenceNo: row.referenceNo,
      issuedOn: row.issuedOn ? row.issuedOn.toISOString().slice(0, 10) : null,
      remarks: row.remarks,
      createdAt: row.createdAt,
    };
  }
}
