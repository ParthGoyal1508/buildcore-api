import {
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Permission, Prisma } from '@prisma/client';

import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator';
import {
  callerFor,
  createPrismaMock,
} from '../../settings/testing/prisma-mock';
import { PurchasesController } from '../purchases/purchases.controller';
import { CreateSiteEntryDto } from './dto/site-entry.dto';
import { SiteEntriesController } from './site-entries.controller';
import { SiteEntriesService } from './site-entries.service';

const caller = callerFor('co-1');

/** The site's geofence centre: 100 m radius around a point in Mumbai. */
const SITE = { latitude: 19.076, longitude: 72.8777 };
/** ~0.0009° of latitude is ~100 m, so this is ~1 km north: well outside. */
const FAR = { latitude: 19.085, longitude: 72.8777 };

const dto = (over: Partial<CreateSiteEntryDto> = {}): CreateSiteEntryDto => ({
  itemId: 'item-1',
  deliveredAt: new Date().toISOString(),
  vehicleNo: ' mh 12 ab 1234 ',
  photo: 'aGVsbG8=',
  latitude: SITE.latitude,
  longitude: SITE.longitude,
  accuracyMeters: 10,
  capturedAt: new Date().toISOString(),
  clientRequestId: '3f0a6a4e-1d0b-4c3e-9a7e-2d9c1b2e4f50',
  ...over,
});

const build = (
  options: {
    stores?: { id: string; name: string }[];
    existing?: Record<string, unknown> | null;
    createFails?: Error;
    isActive?: boolean;
  } = {},
) => {
  const created = {
    id: 'pur-1',
    status: 'partial_site',
    createdAt: new Date(),
  };
  const prisma = createPrismaMock({
    purchase: {
      findUnique: jest.fn().mockResolvedValue(options.existing ?? null),
      create: options.createFails
        ? jest.fn().mockRejectedValue(options.createFails)
        : jest.fn().mockResolvedValue(created),
    },
  });
  const refs = {
    targetCompanyOf: jest.fn().mockReturnValue('co-1'),
    requireItem: jest.fn().mockResolvedValue({
      id: 'item-1',
      code: 'CEM-01',
      name: 'Cement',
      unit: 'bag',
      active: true,
    }),
    findItem: jest.fn().mockResolvedValue({ name: 'Cement', unit: 'bag' }),
    siteNames: jest.fn().mockResolvedValue(new Map([['site-1', 'Site A']])),
    siteGeofence: jest.fn().mockResolvedValue({
      siteId: 'site-1',
      ...SITE,
      geofenceRadiusMeters: 100,
      isActive: options.isActive ?? true,
    }),
    punchAccuracyMaxMetres: jest.fn().mockResolvedValue(50),
  };
  const purchases = {
    storeUpload: jest.fn().mockResolvedValue('photo-ref'),
  };
  const storage = { deleteMany: jest.fn().mockResolvedValue(undefined) };
  const supervisorSites = {
    mySites: jest
      .fn()
      .mockResolvedValue(options.stores ?? [{ id: 'site-1', name: 'Site A' }]),
  };
  const audit = { record: jest.fn() };
  const service = new SiteEntriesService(
    prisma as never,
    audit as never,
    refs as never,
    purchases as never,
    storage as never,
    supervisorSites as never,
    { get: () => ({ timezone: 'Asia/Kolkata' }) } as never,
  );
  return { service, prisma, refs, purchases, storage, audit };
};

describe('SiteEntriesService.create — the geofence (043)', () => {
  it('refuses a photo taken outside the site radius, and stores nothing', async () => {
    const { service, purchases, prisma } = build();
    const failure = service.create(caller, dto(FAR), '127.0.0.1');
    await expect(failure).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(failure).rejects.toMatchObject({
      response: { code: 'SITE_ENTRY_REFUSED_LOCATION', radiusMeters: 100 },
    });
    expect(purchases.storeUpload).not.toHaveBeenCalled();
    expect(prisma.tx.purchase.create).not.toHaveBeenCalled();
  });

  it('applies the attendance rule: radius plus the reported accuracy', async () => {
    // ~120 m out with a 30 m fix: inside 100 + 30.
    const { service, prisma } = build();
    await service.create(
      caller,
      dto({ latitude: 19.07708, accuracyMeters: 30 }),
      '127.0.0.1',
    );
    expect(prisma.tx.purchase.create).toHaveBeenCalled();
  });

  it("refuses a fix vaguer than the company's accuracy ceiling", async () => {
    const { service } = build();
    await expect(
      service.create(caller, dto({ accuracyMeters: 80 }), '127.0.0.1'),
    ).rejects.toMatchObject({
      response: { code: 'SITE_ENTRY_REFUSED_UNLOCATABLE' },
    });
  });

  it('refuses a photo captured more than ten minutes ago', async () => {
    const { service } = build();
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    await expect(
      service.create(caller, dto({ capturedAt: old }), '127.0.0.1'),
    ).rejects.toMatchObject({
      response: { code: 'SITE_ENTRY_REFUSED_STALE_PHOTO' },
    });
  });

  it('refuses a site that is out of service', async () => {
    const { service } = build({ isActive: false });
    await expect(
      service.create(caller, dto(), '127.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SiteEntriesService.create — the store comes from the assignment (043)', () => {
  it('uses the one assigned store and ignores the store the request names', async () => {
    const { service, prisma } = build();
    await service.create(caller, dto({ siteId: 'someone-elses' }), '127.0.0.1');
    expect(prisma.tx.purchase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ siteId: 'site-1', companyId: 'co-1' }),
    });
  });

  it('blocks a caller with no store assigned', async () => {
    const { service } = build({ stores: [] });
    const failure = service.create(caller, dto(), '127.0.0.1');
    await expect(failure).rejects.toBeInstanceOf(ForbiddenException);
    await expect(failure).rejects.toMatchObject({
      response: { code: 'SITE_ENTRY_NO_STORE' },
    });
  });

  const two = [
    { id: 'site-1', name: 'Site A' },
    { id: 'site-2', name: 'Site B' },
  ];

  it('asks a caller with several stores which one', async () => {
    const { service } = build({ stores: two });
    await expect(
      service.create(caller, dto(), '127.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a caller with several stores pick only from their own', async () => {
    const { service, prisma } = build({ stores: two });
    await expect(
      service.create(caller, dto({ siteId: 'site-9' }), '127.0.0.1'),
    ).rejects.toMatchObject({
      response: { code: 'SITE_ENTRY_STORE_NOT_ASSIGNED' },
    });
    await service.create(caller, dto({ siteId: 'site-2' }), '127.0.0.1');
    expect(prisma.tx.purchase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ siteId: 'site-2' }),
    });
  });
});

describe('SiteEntriesService.create — what is saved (043)', () => {
  it('saves a partial site entry with the GPS evidence and nothing of stock', async () => {
    const { service, prisma } = build();
    const view = await service.create(caller, dto(), '127.0.0.1');
    const data = prisma.tx.purchase.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      source: 'site',
      status: 'partial_site',
      createdByUserId: 'caller-1',
      vehicleNo: 'MH12AB1234',
      photoFileRef: 'photo-ref',
      gpsLatitude: SITE.latitude,
      gpsAccuracyMeters: 10,
    });
    expect(data).not.toHaveProperty('vendorId');
    expect(data).not.toHaveProperty('quantity');
    expect(view.vehicleNo).toBe('MH12AB1234');
  });

  it('refuses a vehicle number of only spaces', async () => {
    const { service } = build();
    await expect(
      service.create(caller, dto({ vehicleNo: '   ' }), '127.0.0.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers a repeated submission with the entry already saved, uploading nothing', async () => {
    const { service, prisma, purchases } = build({
      existing: {
        id: 'pur-1',
        status: 'partial_site',
        siteId: 'site-1',
        itemId: 'item-1',
        vehicleNo: 'MH12AB1234',
        createdByUserId: 'caller-1',
        createdAt: new Date(),
      },
    });
    const view = await service.create(caller, dto(), '127.0.0.1');
    expect(view.id).toBe('pur-1');
    expect(purchases.storeUpload).not.toHaveBeenCalled();
    expect(prisma.tx.purchase.create).not.toHaveBeenCalled();
  });

  it('removes the uploaded photo when the entry cannot be saved', async () => {
    const { service, storage } = build({ createFails: new Error('network') });
    await expect(service.create(caller, dto(), '127.0.0.1')).rejects.toThrow(
      'network',
    );
    expect(storage.deleteMany).toHaveBeenCalledWith(['photo-ref']);
  });

  it('answers the losing tap of a double submit with the winner', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const { service, prisma, storage } = build({ createFails: duplicate });
    prisma.tx.purchase.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'pur-1',
        status: 'partial_site',
        siteId: 'site-1',
        itemId: 'item-1',
        createdByUserId: 'caller-1',
        createdAt: new Date(),
      });
    const view = await service.create(caller, dto(), '127.0.0.1');
    expect(view.id).toBe('pur-1');
    expect(storage.deleteMany).toHaveBeenCalledWith(['photo-ref']);
  });
});

describe('permissions (043)', () => {
  const required = (target: object) =>
    Reflect.getMetadata(PERMISSIONS_KEY, target) as Permission[];

  it('gates the site page on its own permission, not INVENTORY', () => {
    expect(required(SiteEntriesController)).toEqual([
      Permission.INVENTORY_SITE_ENTRY,
    ]);
    expect(required(PurchasesController)).toEqual([Permission.INVENTORY]);
  });

  it('gives the site page no list, read, edit or delete', () => {
    const methods = Object.getOwnPropertyNames(
      SiteEntriesController.prototype,
    ).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['create', 'items', 'stores']);
  });
});
