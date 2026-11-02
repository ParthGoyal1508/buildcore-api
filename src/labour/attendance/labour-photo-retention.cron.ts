import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'nestjs-prisma';

import { WorkspaceConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import { daysAgo, sweepPhotos } from '../../common/storage/photo-retention';
import { StorageService } from '../../common/storage/storage.service';

/**
 * Deletes labour attendance photos past their retention (057, client decision 2026-11-02): an
 * accepted punch's after `photoRetention.punchDays` (14), a refused attempt's after `refusalDays`
 * (30). The staff counterpart is `PunchPhotoRetentionCron`; they are separate because each module
 * reads only its own tables.
 *
 * A labour punch's photo is also referenced from the day's muster line (`MusterLine.photoRef`, set
 * by `LabourDayService`), so both are cleared together — a muster line left pointing at a deleted
 * blob would render as a broken photo rather than as none.
 *
 * Group photos of a site (034) are reference pictures, not attendance, and are not covered.
 */
@Injectable()
export class LabourPhotoRetentionCron {
  private readonly logger = new Logger(LabourPhotoRetentionCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  @Cron('40 3 * * *', {
    name: 'labour-photo-retention',
    timeZone: 'Asia/Kolkata',
  })
  async run(now = new Date()): Promise<{ punches: number; refusals: number }> {
    const { punchDays, refusalDays } =
      this.config.get<WorkspaceConfig>('workspace').photoRetention;
    const punchCutoff = daysAgo(punchDays, now);
    const refusalCutoff = daysAgo(refusalDays, now);
    const superAdmin = { isSuperAdmin: true };

    const punches = await sweepPhotos(
      this.storage,
      this.logger,
      'Labour punch photos',
      (take) =>
        withRlsContext(this.prisma, superAdmin, (tx) =>
          tx.labourPunch.findMany({
            where: { photoRef: { not: null }, punchedAt: { lt: punchCutoff } },
            orderBy: { punchedAt: 'asc' },
            take,
            select: { id: true, photoRef: true },
          }),
        ) as Promise<{ id: string; photoRef: string }[]>,
      async (rows) => {
        const refs = rows.map((r) => r.photoRef);
        await withRlsContext(this.prisma, superAdmin, (tx) =>
          Promise.all([
            tx.labourPunch.updateMany({
              where: { id: { in: rows.map((r) => r.id) } },
              data: { photoRef: null },
            }),
            tx.musterLine.updateMany({
              where: { photoRef: { in: refs } },
              data: { photoRef: null },
            }),
          ]),
        );
      },
    );

    const refusals = await sweepPhotos(
      this.storage,
      this.logger,
      'Refused labour punch photos',
      (take) =>
        withRlsContext(this.prisma, superAdmin, (tx) =>
          tx.labourPunchRefusal.findMany({
            where: {
              photoRef: { not: null },
              createdAt: { lt: refusalCutoff },
            },
            orderBy: { createdAt: 'asc' },
            take,
            select: { id: true, photoRef: true },
          }),
        ) as Promise<{ id: string; photoRef: string }[]>,
      async (rows) => {
        await withRlsContext(this.prisma, superAdmin, (tx) =>
          tx.labourPunchRefusal.updateMany({
            where: { id: { in: rows.map((r) => r.id) } },
            data: { photoRef: null },
          }),
        );
      },
    );

    return { punches, refusals };
  }
}
