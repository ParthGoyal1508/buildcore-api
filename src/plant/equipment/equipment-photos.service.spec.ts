import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import {
  EquipmentPhotosService,
  MAX_PHOTOS_PER_EQUIPMENT,
} from './equipment-photos.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');

const caller = callerFor('co-1');

const photoRow = (over: Record<string, unknown> = {}) => ({
  id: 'ph-1',
  companyId: 'co-1',
  equipmentId: 'eq-1',
  fileRef: 'f-1',
  thumbnailRef: 't-1',
  contentType: 'image/jpeg',
  fileName: 'front.jpg',
  width: 2048,
  height: 1536,
  sizeBytes: 1000,
  isMain: false,
  uploadedByUserId: 'caller-1',
  uploadedAt: new Date(),
  ...over,
});

const build = (count = 0) => {
  const prisma = createPrismaMock({
    equipment: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'eq-1', companyId: 'co-1' }),
    },
    equipmentPhoto: {
      count: jest.fn().mockResolvedValue(count),
      updateMany: jest.fn(),
      create: jest.fn(async ({ data }: never) =>
        photoRow(data as Record<string, unknown>),
      ),
      findFirst: jest.fn(),
      update: jest.fn(async ({ data }: never) =>
        photoRow(data as Record<string, unknown>),
      ),
      delete: jest.fn(),
    },
  });
  const storage = {
    put: jest
      .fn()
      .mockResolvedValueOnce('main-ref')
      .mockResolvedValueOnce('thumb-ref'),
    get: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { record: jest.fn() };
  const service = new EquipmentPhotosService(
    prisma as never,
    audit as never,
    storage as never,
  );
  return { service, prisma, storage };
};

const photo = async (width = 3000, height = 2000) =>
  (
    (await sharp({
      create: { width, height, channels: 3, background: '#f80' },
    })
      .png()
      .toBuffer()) as Buffer
  ).toString('base64');

describe('EquipmentPhotosService (036 K14)', () => {
  it("makes the machine's first photo its main one, compressed with a thumbnail", async () => {
    const { service, prisma, storage } = build(0);
    const view = await service.upload(
      caller,
      'eq-1',
      { file: await photo(), fileName: 'front.png' },
      'ip',
    );
    expect(view.isMain).toBe(true);
    const data = prisma.tx.equipmentPhoto.create.mock.calls[0][0].data;
    expect(Math.max(data.width, data.height)).toBeLessThanOrEqual(2048);
    expect(data.fileRef).toBe('main-ref');
    expect(data.thumbnailRef).toBe('thumb-ref');
    expect(storage.put).toHaveBeenCalledTimes(2);
  });

  it('adds a later photo to the gallery unless asked to make it main', async () => {
    const { service } = build(2);
    const view = await service.upload(
      caller,
      'eq-1',
      { file: await photo(400, 300) },
      'ip',
    );
    expect(view.isMain).toBe(false);
  });

  it('refuses a file that is not a photo (415)', async () => {
    const { service, storage } = build(0);
    await expect(
      service.upload(
        caller,
        'eq-1',
        { file: Buffer.from('%PDF-1.4\n').toString('base64') },
        'ip',
      ),
    ).rejects.toMatchObject({ status: 415 });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('refuses a photo past the gallery limit and removes the stored blobs', async () => {
    const { service, storage } = build(MAX_PHOTOS_PER_EQUIPMENT);
    await expect(
      service.upload(caller, 'eq-1', { file: await photo(200, 200) }, 'ip'),
    ).rejects.toMatchObject({ status: 409 });
    expect(storage.delete).toHaveBeenCalledWith('main-ref');
    expect(storage.delete).toHaveBeenCalledWith('thumb-ref');
  });

  it('promotes the newest remaining photo when the main one is deleted', async () => {
    const { service, prisma } = build();
    prisma.tx.equipmentPhoto.findFirst
      .mockResolvedValueOnce(photoRow({ isMain: true }))
      .mockResolvedValueOnce({ id: 'ph-2' });
    await service.remove(caller, 'eq-1', 'ph-1', 'ip');
    expect(prisma.tx.equipmentPhoto.delete).toHaveBeenCalledWith({
      where: { id: 'ph-1' },
    });
    expect(prisma.tx.equipmentPhoto.update).toHaveBeenCalledWith({
      where: { id: 'ph-2' },
      data: { isMain: true },
    });
  });
});
