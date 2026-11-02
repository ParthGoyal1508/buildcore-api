import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ExceptionResolution } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { WorkspaceConfig } from '../../common/configs/config.interface';
import { withRlsContext } from '../../common/prisma/rls-context';
import { daysAgo, sweepPhotos } from '../../common/storage/photo-retention';
import { StorageService } from '../../common/storage/storage.service';

/**
 * Deletes staff attendance photos past their retention (057, client decision 2026-11-02).
 *
 * - An accepted punch's photo after `photoRetention.punchDays` (14) — **except** a punch whose
 *   exception is still pending review: its photo is the evidence the reviewer is about to look at,
 *   and it goes on the first run after the exception is resolved.
 * - A refused attempt's photo after `photoRetention.refusalDays` (30).
 *
 * Only the picture goes. The punch, its time, its location and its match distance stay, so payroll,
 * registers and the refusal log read exactly as before.
 */
@Injectable()
export class PunchPhotoRetentionCron {
  private readonly logger = new Logger(PunchPhotoRetentionCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  @Cron('30 3 * * *', {
    name: 'punch-photo-retention',
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
      'Punch photos',
      (take) =>
        withRlsContext(this.prisma, superAdmin, (tx) =>
          tx.punchRecord.findMany({
            where: {
              photoRef: { not: null },
              capturedAt: { lt: punchCutoff },
              OR: [
                { exceptionResolution: null },
                { exceptionResolution: { not: ExceptionResolution.pending } },
              ],
            },
            orderBy: { capturedAt: 'asc' },
            take,
            select: { id: true, photoRef: true },
          }),
        ) as Promise<{ id: string; photoRef: string }[]>,
      async (rows) => {
        await withRlsContext(this.prisma, superAdmin, (tx) =>
          tx.punchRecord.updateMany({
            where: { id: { in: rows.map((r) => r.id) } },
            data: { photoRef: null },
          }),
        );
      },
    );

    const refusals = await sweepPhotos(
      this.storage,
      this.logger,
      'Refused punch photos',
      (take) =>
        withRlsContext(this.prisma, superAdmin, (tx) =>
          tx.punchRefusal.findMany({
            where: {
              photoRef: { not: null },
              capturedAt: { lt: refusalCutoff },
            },
            orderBy: { capturedAt: 'asc' },
            take,
            select: { id: true, photoRef: true },
          }),
        ) as Promise<{ id: string; photoRef: string }[]>,
      async (rows) => {
        await withRlsContext(this.prisma, superAdmin, (tx) =>
          tx.punchRefusal.updateMany({
            where: { id: { in: rows.map((r) => r.id) } },
            data: { photoRef: null },
          }),
        );
      },
    );

    return { punches, refusals };
  }
}
