import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, AuditEntityType, Signatory } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { CreateSignatoryDto, UpdateSignatoryDto } from './dto/signatory.dto';

/** Where signature graphics live in blob storage. */
export const SIGNATURE_NAMESPACE = 'signature';

export interface SignatoryView {
  id: string;
  name: string;
  title: string;
  isActive: boolean;
}

const toView = (row: Signatory): SignatoryView => ({
  id: row.id,
  name: row.name,
  title: row.title,
  isActive: row.isActive,
});

/**
 * Named signatories and their graphics (017 US4, FR-016, research §5).
 *
 * The graphic goes through the existing `StorageService` — the same encrypted blob path
 * every other document in this product uses. A second storage path for signatures would
 * be a second thing to encrypt, back up and rotate.
 */
@Injectable()
export class SignatoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditLogService,
  ) {}

  async listFor(
    ctx: RlsContext,
    companyId: string,
    opts: { includeInactive?: boolean } = {},
  ): Promise<SignatoryView[]> {
    const rows = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.signatory.findMany({
        where: {
          companyId,
          ...(opts.includeInactive ? {} : { isActive: true }),
        },
        orderBy: { name: 'asc' },
      }),
    );
    return rows.map(toView);
  }

  /** The full row, graphic reference included — for the renderer, not for a client. */
  async requireById(
    ctx: RlsContext,
    companyId: string,
    id: string,
  ): Promise<Signatory> {
    const row = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.signatory.findFirst({ where: { id, companyId } }),
    );
    if (!row) throw new NotFoundException(`Signatory ${id} not found.`);
    return row;
  }

  async create(
    ctx: RlsContext,
    companyId: string,
    dto: CreateSignatoryDto,
    actor: { userId: string; ipAddress: string },
  ): Promise<SignatoryView> {
    const signatureRef = await this.storage.put(
      `${SIGNATURE_NAMESPACE}/${companyId}`,
      Buffer.from(dto.signature, 'base64'),
      dto.contentType ?? 'image/png',
    );

    const created = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.signatory.create({
        data: {
          companyId,
          name: dto.name.trim(),
          title: dto.title.trim(),
          signatureRef,
        },
      }),
    );

    await this.audit.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: { signatory: created.name },
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });
    return toView(created);
  }

  /**
   * Edit a signatory, optionally replacing the graphic.
   *
   * **The old graphic is not deleted.** Every letter issued with it holds its reference
   * in `appliedSignatureRef`, and deleting the blob would leave those letters pointing
   * at nothing — FR-013 requires them to render as they were issued, which means the
   * bytes have to still be there. The storage cost of keeping a few kilobytes of PNG is
   * not a reason to make a signed letter unrenderable.
   */
  async update(
    ctx: RlsContext,
    companyId: string,
    id: string,
    dto: UpdateSignatoryDto,
    actor: { userId: string; ipAddress: string },
  ): Promise<SignatoryView> {
    await this.requireById(ctx, companyId, id);

    const signatureRef = dto.signature
      ? await this.storage.put(
          `${SIGNATURE_NAMESPACE}/${companyId}`,
          Buffer.from(dto.signature, 'base64'),
          dto.contentType ?? 'image/png',
        )
      : undefined;

    const updated = await withRlsContext(this.prisma, ctx, (tx) =>
      tx.signatory.update({
        where: { id },
        data: {
          name: dto.name?.trim() ?? undefined,
          title: dto.title?.trim() ?? undefined,
          signatureRef,
          isActive: dto.isActive ?? undefined,
        },
      }),
    );

    await this.audit.record({
      entityType: AuditEntityType.LETTER,
      action: AuditAction.UPDATE,
      entityId: id,
      changes: { signatureReplaced: Boolean(signatureRef) },
      accountId: actor.userId,
      companyId,
      ipAddress: actor.ipAddress,
    });
    return toView(updated);
  }
}
