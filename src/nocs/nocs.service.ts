import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Permission } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../common/prisma/rls-context';
import { StorageService } from '../common/storage/storage.service';
import { assertInScope } from '../settings/company-scope';
import type { ListNocsDto, NocSubject, UploadNocDto } from './dto/noc.dto';

/** Ten megabytes — the ceiling every document upload in the app shares. */
const MAX_NOC_BYTES = 10 * 1024 * 1024;

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
    this.assertMay(caller, query.subjectType);
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

  async upload(caller: AuthenticatedUser, dto: UploadNocDto): Promise<NocView> {
    this.assertMay(caller, dto.subjectType);
    const companyId = rlsContextFor(caller).companyId ?? caller.companyId;
    if (!companyId) {
      throw new BadRequestException('Choose a company before uploading a NOC.');
    }
    if (dto.stage && dto.subjectType !== 'work_order') {
      throw new BadRequestException('Only a work order NOC names a stage.');
    }
    // TODO(VIRUS_SCAN): stored unscanned, the same gap every document upload here carries.
    const buffer = Buffer.from(dto.file, 'base64');
    if (buffer.length === 0) {
      throw new BadRequestException('The file is empty.');
    }
    if (buffer.length > MAX_NOC_BYTES) {
      throw new BadRequestException('The file is over 10 MB.');
    }
    const fileRef = await this.storage.put(
      'noc-documents',
      buffer,
      dto.contentType ?? 'application/octet-stream',
    );
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
            mimeType: dto.contentType ?? null,
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
    const row = await this.load(caller, id);
    await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.nocDocument.delete({ where: { id: row.id } }),
    );
    // The file goes with its record; a NOC removed by mistake is uploaded again.
    await this.storage.delete(row.fileRef).catch(() => undefined);
  }

  private async load(caller: AuthenticatedUser, id: string) {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.nocDocument.findUnique({ where: { id } }),
    );
    if (!row) throw new NotFoundException('NOC not found');
    assertInScope(caller, row, 'NOC');
    this.assertMay(caller, row.subjectType as NocSubject);
    return row;
  }

  private assertMay(caller: AuthenticatedUser, subject: NocSubject) {
    const needed = SUBJECT_PERMISSION[subject];
    if (!needed)
      throw new BadRequestException(`Unknown NOC subject ${subject}`);
    if (!caller.permissions.includes(needed)) {
      throw new ForbiddenException(
        'You do not have access to the record this NOC belongs to.',
      );
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
