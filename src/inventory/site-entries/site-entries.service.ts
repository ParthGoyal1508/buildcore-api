import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  Purchase,
  PurchaseSource,
  PurchaseStatus,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { AuditLogService } from '../../auth/audit-log.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import type { SettingsConfig } from '../../common/configs/config.interface';
import { rlsContextFor, withRlsContext } from '../../common/prisma/rls-context';
import { StorageService } from '../../common/storage/storage.service';
import { IMAGE_TYPES } from '../../common/uploads';
import { parseDateOnly, zonedDateOnly } from '../../hr/leave/leave-days';
import { checkGeofence } from '../../hr/punch/geofence.util';
import {
  SiteOption,
  SupervisorSiteService,
} from '../../labour/supervisor-sites/supervisor-site.service';
import { InventoryRefsService } from '../inventory-refs.service';
import { PurchasesService } from '../purchases/purchases.service';
import { normaliseVehicleNo } from '../purchases/vehicle-no';
import { CreateSiteEntryDto } from './dto/site-entry.dto';
import { noStoreAssigned, siteEntryRefused } from './site-entry-refusal';

/** How old a photo may be when it reaches the server — long enough for a slow upload, no longer. */
const MAX_CAPTURE_AGE_MS = 10 * 60_000;
/** How far ahead of the server a phone's clock may run, as the punch allows (036 G1). */
const MAX_CLOCK_AHEAD_MS = 5 * 60_000;

export interface SiteEntryView {
  id: string;
  status: PurchaseStatus;
  siteId: string;
  siteName: string;
  itemId: string;
  itemName: string;
  unit: string;
  vehicleNo: string;
  deliveredAt: Date;
  distanceMeters: number;
  createdAt: Date;
}

/**
 * Deliveries recorded at the site (043): the "Create Inventory Purchase" page.
 *
 * Creates and nothing else. The caller holds `INVENTORY_SITE_ENTRY`, which opens no list, stock or
 * edit — the entry it saves is a partial purchase that moves nothing until Head Office completes it
 * (`PurchasesService.complete`).
 *
 * The store is the caller's assignment, never the request's: the sites HR assigns them for labour
 * attendance (031's `SupervisorSite`), the same Site In-charge marking attendance at the same site.
 */
@Injectable()
export class SiteEntriesService {
  private readonly timeZone: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly refs: InventoryRefsService,
    private readonly purchases: PurchasesService,
    private readonly storage: StorageService,
    // forwardRef: `labour` reaches back to `inventory` through projects → hr → payroll → plant.
    @Inject(forwardRef(() => SupervisorSiteService))
    private readonly supervisorSites: SupervisorSiteService,
    configService: ConfigService,
  ) {
    this.timeZone = configService.get<SettingsConfig>('settings').timezone;
  }

  /** The stores the caller may record against — empty means none is assigned. */
  async myStores(caller: AuthenticatedUser): Promise<SiteOption[]> {
    return this.supervisorSites.mySites(caller);
  }

  /** The item picker: the same item master Head Office's purchase form reads, active items only. */
  async items(
    caller: AuthenticatedUser,
    search?: string,
  ): Promise<{ id: string; code: string; name: string; unit: string }[]> {
    const items = await this.refs.searchActiveItems(caller, search);
    return items.map(({ id, code, name, unit }) => ({ id, code, name, unit }));
  }

  async create(
    caller: AuthenticatedUser,
    dto: CreateSiteEntryDto,
    ipAddress: string,
  ): Promise<SiteEntryView> {
    const vehicleNo = normaliseVehicleNo(dto.vehicleNo);
    if (!vehicleNo) {
      throw new BadRequestException('Enter the vehicle number.');
    }

    // A second tap, or a retry after the connection dropped, finds the entry the first one saved.
    // Checked before the photo is uploaded, so a repeat stores nothing.
    const repeat = await this.byRequestId(caller, dto.clientRequestId);
    if (repeat) return this.viewOf(caller, repeat);

    const site = this.pickStore(await this.myStores(caller), dto.siteId);
    const companyId = this.refs.targetCompanyOf(caller);
    const item = await this.refs.requireItem(caller, dto.itemId, companyId);
    if (!item.active) {
      throw new BadRequestException(
        `Item ${item.code} is retired and cannot be purchased.`,
      );
    }

    const now = Date.now();
    const capturedAt = new Date(dto.capturedAt);
    const deliveredAt = new Date(dto.deliveredAt);
    if (capturedAt.getTime() > now + MAX_CLOCK_AHEAD_MS) {
      throw new BadRequestException(
        "The photo's time is ahead of the server. Check the phone's date and time, then try again.",
      );
    }
    if (capturedAt.getTime() < now - MAX_CAPTURE_AGE_MS) {
      throw siteEntryRefused('stale_capture');
    }
    if (deliveredAt.getTime() > now + MAX_CLOCK_AHEAD_MS) {
      throw new BadRequestException(
        'The delivery time cannot be in the future.',
      );
    }

    // --- Location: the attendance rule (020 FR-011 to FR-013), always enforced here. ---
    // A punch's location refusal waits on the company's block switch because refusing it can cost
    // someone a day's pay; refusing a delivery photo costs a retake, and an entry recorded from the
    // wrong place is exactly what the photo exists to rule out.
    const geofence = await this.refs.siteGeofence(caller, site.id);
    if (!geofence.isActive) {
      throw new BadRequestException(
        'This site is no longer in service, so deliveries cannot be recorded here.',
      );
    }
    const accuracyMax = await this.refs.punchAccuracyMaxMetres(companyId);
    if (dto.accuracyMeters > accuracyMax) {
      throw siteEntryRefused('unlocatable', {
        accuracyMeters: dto.accuracyMeters,
        accuracyMaxMeters: accuracyMax,
      });
    }
    const { withinGeofence, distanceMeters } = checkGeofence(
      {
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracyMeters: dto.accuracyMeters,
      },
      geofence,
    );
    if (!withinGeofence) {
      throw siteEntryRefused('outside_geofence', {
        distanceMeters: Math.round(distanceMeters),
        radiusMeters: geofence.geofenceRadiusMeters,
      });
    }

    // Uploaded before the row is written, as every purchase upload is: a failed upload has saved
    // nothing. If the write then fails, the photo is removed again, so nothing is half-saved.
    const photoFileRef = await this.purchases.storeUpload(
      dto.photo,
      IMAGE_TYPES,
      'The delivery photo',
    );

    let created: Purchase;
    try {
      created = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
        tx.purchase.create({
          data: {
            companyId,
            siteId: site.id,
            itemId: item.id,
            date: parseDateOnly(zonedDateOnly(deliveredAt, this.timeZone)),
            source: PurchaseSource.site,
            status: PurchaseStatus.partial_site,
            vehicleNo,
            deliveredAt,
            photoFileRef,
            gpsLatitude: dto.latitude,
            gpsLongitude: dto.longitude,
            gpsAccuracyMeters: dto.accuracyMeters,
            gpsCapturedAt: capturedAt,
            geofenceDistanceMeters: new Prisma.Decimal(
              distanceMeters.toFixed(2),
            ),
            createdByUserId: caller.id,
            clientRequestId: dto.clientRequestId,
          },
        }),
      );
    } catch (error) {
      await this.storage.deleteMany([photoFileRef]).catch(() => undefined);
      // Two taps that both passed the check above: the second loses the unique index race and is
      // answered with what the first saved.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.byRequestId(caller, dto.clientRequestId);
        if (winner) return this.viewOf(caller, winner);
      }
      throw error;
    }

    await this.auditLog.record({
      entityType: AuditEntityType.PURCHASE,
      action: AuditAction.CREATE,
      entityId: created.id,
      changes: {
        after: {
          source: PurchaseSource.site,
          status: PurchaseStatus.partial_site,
          siteId: site.id,
          itemId: item.id,
          vehicleNo,
          deliveredAt,
          distanceMeters: Math.round(distanceMeters),
        },
      },
      accountId: caller.id,
      companyId,
      ipAddress,
    });

    return {
      id: created.id,
      status: created.status,
      siteId: site.id,
      siteName: site.name,
      itemId: item.id,
      itemName: item.name,
      unit: item.unit,
      vehicleNo,
      deliveredAt,
      distanceMeters: Math.round(distanceMeters),
      createdAt: created.createdAt,
    };
  }

  /**
   * The store this entry is for. With one assigned, that one — whatever the request said. With
   * several, the one the caller picked, and only from their own.
   */
  private pickStore(stores: SiteOption[], requested?: string): SiteOption {
    if (stores.length === 0) throw noStoreAssigned();
    if (stores.length === 1) return stores[0];
    if (!requested) {
      throw new BadRequestException(
        'You are assigned to more than one site. Choose the store this delivery is for.',
      );
    }
    const store = stores.find((s) => s.id === requested);
    if (!store) {
      throw new ForbiddenException({
        code: 'SITE_ENTRY_STORE_NOT_ASSIGNED',
        message:
          'You are not assigned to this store. Ask the HR office to assign it to you.',
      });
    }
    return store;
  }

  /** The caller's own entry for this request id. Another user's id is refused, never returned. */
  private async byRequestId(
    caller: AuthenticatedUser,
    clientRequestId: string,
  ): Promise<Purchase | null> {
    const row = await withRlsContext(this.prisma, rlsContextFor(caller), (tx) =>
      tx.purchase.findUnique({ where: { clientRequestId } }),
    );
    if (row && row.createdByUserId !== caller.id) {
      throw new ConflictException('This entry was already submitted.');
    }
    return row;
  }

  private async viewOf(
    caller: AuthenticatedUser,
    row: Purchase,
  ): Promise<SiteEntryView> {
    const [item, siteNames] = await Promise.all([
      this.refs.findItem(caller, row.itemId),
      this.refs.siteNames(caller, [row.siteId]),
    ]);
    return {
      id: row.id,
      status: row.status,
      siteId: row.siteId,
      siteName: siteNames.get(row.siteId) ?? 'Unknown store',
      itemId: row.itemId,
      itemName: item?.name ?? 'Unknown item',
      unit: item?.unit ?? '',
      vehicleNo: row.vehicleNo ?? '',
      deliveredAt: row.deliveredAt ?? row.createdAt,
      distanceMeters: Math.round(Number(row.geofenceDistanceMeters ?? 0)),
      createdAt: row.createdAt,
    };
  }
}
