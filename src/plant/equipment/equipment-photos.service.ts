import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, AuditEntityType, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import {
  assertAllowedFileType,
  compressImageUpload,
  decodeBase64Upload,
  IMAGE_TYPES,
} from '../../common/uploads';
import { assertInScope } from '../../settings/company-scope';
import { UploadEquipmentPhotoDto } from './dto/equipment.dto';
import { EquipmentPhotoView, toPhotoView } from './equipment.service';

/** A gallery, not an archive: enough angles of one machine, and a bound on what a page loads. */
export const MAX_PHOTOS_PER_EQUIPMENT = 20;

/**
 * Equipment photos (036 K14): an optional main photo plus a gallery.
 *
 * - **Never required.** Nothing reads a photo to decide anything; the register shows a placeholder
 *   icon for a machine without one.
 * - **Compressed twice.** The browser shrinks a phone photo to ~2048 px before sending it, and
 *   `compressImageUpload` re-encodes it here (≤ 2048 px JPEG, EXIF and GPS dropped) and makes the
 *   320 px thumbnail the list and gallery load. A file that is not a JPEG, PNG or WebP photo is
 *   refused (415) — HEIC the browser could not convert included.
 * - **One main photo.** The first photo of a machine becomes its main one, as does the newest
 *   remaining photo when the main one is deleted, so a machine with photos always shows one. A
 *   partial unique index in the migration keeps it to one per machine.
 */
@Injectable()
export class EquipmentPhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly storage: StorageService,
  ) {}

  async upload(
    caller: AuthenticatedUser,
    equipmentId: string,
    dto: UploadEquipmentPhotoDto,
    ipAddress: string,
  ): Promise<EquipmentPhotoView> {
    const equipment = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipment.findUnique({
          where: { id: equipmentId },
          select: { id: true, companyId: true },
        }),
    );
    if (!equipment) throw new NotFoundException('Equipment not found');
    assertInScope(caller, equipment, 'Equipment');

    const bytes = decodeBase64Upload(dto.file, 'The photo');
    const detected = assertAllowedFileType(bytes, IMAGE_TYPES, 'The photo');
    const image = await compressImageUpload(bytes, detected.contentType);
    if (!image) {
      throw new BadRequestException(
        'The photo could not be read as an image. Take or choose it again.',
      );
    }

    // Stored before the row, removed again if the row cannot be written: an orphaned blob is a
    // cleanup job, a row without its blob is a broken image.
    const [fileRef, thumbnailRef] = await Promise.all([
      this.storage.put(
        'equipment-photos',
        image.main.data,
        image.main.contentType,
      ),
      this.storage.put(
        'equipment-photos',
        image.thumbnail.data,
        image.thumbnail.contentType,
      ),
    ]);

    let created;
    try {
      created = await withRlsContext(
        this.prisma,
        rlsContextFor(caller),
        async (tx) => {
          const count = await tx.equipmentPhoto.count({
            where: { equipmentId },
          });
          if (count >= MAX_PHOTOS_PER_EQUIPMENT) {
            throw new ConflictException(
              `This machine already has ${MAX_PHOTOS_PER_EQUIPMENT} photos. Delete one to add another.`,
            );
          }
          const makeMain = count === 0 || dto.makeMain === true;
          if (makeMain) {
            await tx.equipmentPhoto.updateMany({
              where: { equipmentId, isMain: true },
              data: { isMain: false },
            });
          }
          return tx.equipmentPhoto.create({
            data: {
              companyId: equipment.companyId,
              equipmentId,
              fileRef,
              thumbnailRef,
              contentType: image.main.contentType,
              fileName: dto.fileName?.trim() || null,
              width: image.main.width,
              height: image.main.height,
              sizeBytes: image.main.data.length,
              isMain: makeMain,
              uploadedByUserId: caller.id,
            },
          });
        },
      );
    } catch (error) {
      await Promise.all([
        this.storage.delete(fileRef).catch(() => undefined),
        this.storage.delete(thumbnailRef).catch(() => undefined),
      ]);
      throw error;
    }

    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT,
      action: AuditAction.UPDATE,
      entityId: equipmentId,
      accountId: caller.id,
      companyId: equipment.companyId,
      ipAddress,
      changes: {
        kind: 'photo_added',
        photoId: created.id,
        isMain: created.isMain,
      },
    });
    return toPhotoView(created);
  }

  /** The stored photo or its thumbnail, with the stored type. */
  async file(
    caller: AuthenticatedUser,
    equipmentId: string,
    photoId: string,
    size: 'thumb' | 'full',
  ): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const photo = await this.find(caller, equipmentId, photoId);
    const extension = photo.contentType === 'image/webp' ? 'webp' : 'jpg';
    return {
      buffer: await this.storage.get(
        size === 'thumb' ? photo.thumbnailRef : photo.fileRef,
      ),
      contentType: photo.contentType,
      fileName:
        size === 'thumb'
          ? `${photoId}-thumb.${extension}`
          : photo.fileName ?? `${photoId}.${extension}`,
    };
  }

  async setMain(
    caller: AuthenticatedUser,
    equipmentId: string,
    photoId: string,
    ipAddress: string,
  ): Promise<EquipmentPhotoView> {
    const photo = await this.find(caller, equipmentId, photoId);
    const updated = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      async (tx) => {
        await tx.equipmentPhoto.updateMany({
          where: { equipmentId, isMain: true, id: { not: photoId } },
          data: { isMain: false },
        });
        return tx.equipmentPhoto.update({
          where: { id: photoId },
          data: { isMain: true },
        });
      },
    );
    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT,
      action: AuditAction.UPDATE,
      entityId: equipmentId,
      accountId: caller.id,
      companyId: photo.companyId,
      ipAddress,
      changes: { kind: 'main_photo_set', photoId },
    });
    return toPhotoView(updated);
  }

  async remove(
    caller: AuthenticatedUser,
    equipmentId: string,
    photoId: string,
    ipAddress: string,
  ): Promise<void> {
    const photo = await this.find(caller, equipmentId, photoId);
    await withRlsContext(this.prisma, rlsContextFor(caller), async (tx) => {
      await tx.equipmentPhoto.delete({ where: { id: photoId } });
      if (photo.isMain) {
        const next = await tx.equipmentPhoto.findFirst({
          where: { equipmentId },
          orderBy: { uploadedAt: 'desc' },
          select: { id: true },
        });
        if (next) {
          await tx.equipmentPhoto.update({
            where: { id: next.id },
            data: { isMain: true },
          });
        }
      }
    });
    // Blobs after the row, never before (see `EquipmentService.deleteDocument`).
    await Promise.all([
      this.storage.delete(photo.fileRef).catch(() => undefined),
      this.storage.delete(photo.thumbnailRef).catch(() => undefined),
    ]);
    await this.auditLog.record({
      entityType: AuditEntityType.EQUIPMENT,
      action: AuditAction.UPDATE,
      entityId: equipmentId,
      accountId: caller.id,
      companyId: photo.companyId,
      ipAddress,
      changes: {
        kind: 'photo_deleted',
        photoId,
        wasMain: photo.isMain,
        fileName: photo.fileName,
      } as Prisma.InputJsonObject,
    });
  }

  private async find(
    caller: AuthenticatedUser,
    equipmentId: string,
    photoId: string,
  ) {
    const photo = await withRlsContext(
      this.prisma,
      rlsContextFor(caller),
      (tx) =>
        tx.equipmentPhoto.findFirst({ where: { id: photoId, equipmentId } }),
    );
    if (!photo) throw new NotFoundException('Photo not found');
    assertInScope(caller, photo, 'Photo');
    return photo;
  }
}
