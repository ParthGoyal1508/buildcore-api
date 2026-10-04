import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PunchRefusalReason, PunchType } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { RlsContext, withRlsContext } from '../../common/prisma/rls-context';

export interface PunchRefusalInput {
  companyId: string;
  employeeId: string;
  type: PunchType;
  reason: PunchRefusalReason;
  latitude: number;
  longitude: number;
  distanceMeters?: number | null;
  accuracyMeters?: number | null;
  faceMatchDistance?: number | null;
  capturedAt: Date;
}

/**
 * Records punches that were refused, or in Phase 2 would have been (020 FR-013c).
 *
 * **This is how a refused punch stays visible to somebody.** Under FR-013a the day reads as no punch
 * at all — which is the point of the requirement — so without this table the refusal would leave no
 * trace anywhere, and a worker wrongly refused would have nothing to appeal to. The record is not a
 * consolation prize; it is the only evidence the event happened.
 */
/**
 * What a refusal looks like to a reader of the log.
 *
 * `faceMatchDistance` is included and the photo is not — there is no photo. A refused punch stores
 * no image, because the blob would outlive the only row that ever referred to it. The distance is a
 * number derived from a comparison, not a biometric, and it is the one piece of evidence that
 * distinguishes "the camera saw somebody else" from "the light was bad".
 */
const REFUSAL_ROW_SELECT = {
  id: true,
  employeeId: true,
  type: true,
  reason: true,
  latitude: true,
  longitude: true,
  distanceMeters: true,
  accuracyMeters: true,
  faceMatchDistance: true,
  capturedAt: true,
  createdAt: true,
} as const;

export type PunchRefusalRow = {
  id: string;
  employeeId: string;
  type: PunchType;
  reason: PunchRefusalReason;
  latitude: Prisma.Decimal;
  longitude: Prisma.Decimal;
  distanceMeters: Prisma.Decimal | null;
  accuracyMeters: number | null;
  faceMatchDistance: Prisma.Decimal | null;
  capturedAt: Date;
  createdAt: Date;
};

@Injectable()
export class PunchRefusalsService {
  private readonly logger = new Logger(PunchRefusalsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes one refusal.
   *
   * **Never throws.** In Phase 2 the punch is still being accepted, so a failure here must not turn
   * an accepted punch into a 500 — and in Phase 3, where the punch is refused, a failure here must
   * not turn a considered refusal into an unexplained server error. Either way the worker's outcome
   * is already decided and this is the record of it, so the loss is logged instead.
   */
  async record(ctx: RlsContext, input: PunchRefusalInput): Promise<void> {
    try {
      await withRlsContext(this.prisma, ctx, (tx) =>
        tx.punchRefusal.create({
          data: {
            companyId: input.companyId,
            employeeId: input.employeeId,
            type: input.type,
            reason: input.reason,
            latitude: input.latitude,
            longitude: input.longitude,
            // The **real** distance, not one adjusted by the accuracy allowance. This is evidence,
            // and putting an adjusted figure in an audit trail is putting a fiction in it.
            distanceMeters: input.distanceMeters ?? null,
            accuracyMeters: input.accuracyMeters ?? null,
            faceMatchDistance: input.faceMatchDistance ?? null,
            capturedAt: input.capturedAt,
          },
        }),
      );
    } catch (error) {
      this.logger.error(
        `Could not record a punch refusal for employee ${input.employeeId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * One employee's own refusals, most recent first (020 FR-013b, T026).
   *
   * The companion to the 422 the attempt itself returned. FR-013b is satisfied at the moment of
   * refusal — the reason travels in the response — but that response is gone as soon as the screen
   * is, and the day reads as a day with no punch. This is what answers "what happened last
   * Tuesday" without an administrator in the loop.
   *
   * **No resolve, approve or dismiss accompanies this.** FR-013c specifies a log, not a work queue;
   * a refusal is not an item anybody actions, because there is nothing to action — the punch does
   * not exist. The way back is feature 016's manual correction, which creates attendance from
   * nothing and is already reviewed by somebody.
   */
  async forEmployee(
    ctx: RlsContext,
    employeeId: string,
    range?: { from?: Date; to?: Date },
  ): Promise<PunchRefusalRow[]> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.punchRefusal.findMany({
        where: {
          employeeId,
          ...(range?.from || range?.to
            ? {
                capturedAt: {
                  ...(range.from ? { gte: range.from } : {}),
                  ...(range.to ? { lte: range.to } : {}),
                },
              }
            : {}),
        },
        orderBy: { capturedAt: 'desc' },
        select: REFUSAL_ROW_SELECT,
      }),
    );
  }

  /**
   * The company's refusals, for whoever audits attendance (020 FR-013c, T027).
   *
   * Filtered by employee, by day range and by reason, because the questions asked of this log are
   * "is this person being refused repeatedly" and "did something change on Tuesday" — and a log that
   * can only be read from the top answers neither once it is a month old.
   */
  async list(
    ctx: RlsContext,
    companyId: string,
    filter: {
      employeeId?: string;
      from?: Date;
      to?: Date;
      reason?: PunchRefusalReason;
    } = {},
  ): Promise<PunchRefusalRow[]> {
    return withRlsContext(this.prisma, ctx, (tx) =>
      tx.punchRefusal.findMany({
        where: {
          companyId,
          ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
          ...(filter.reason ? { reason: filter.reason } : {}),
          ...(filter.from || filter.to
            ? {
                capturedAt: {
                  ...(filter.from ? { gte: filter.from } : {}),
                  ...(filter.to ? { lte: filter.to } : {}),
                },
              }
            : {}),
        },
        orderBy: { capturedAt: 'desc' },
        select: REFUSAL_ROW_SELECT,
      }),
    );
  }

  /**
   * The refusal rate over a window — **the number Phase 2 exists to produce** (T016).
   *
   * Phase 3 switches FR-013's hard block on, and the client accepted its cost without knowing how
   * often it would fire. Delivering that figure while the decision is still reversible is the whole
   * purpose of running Phase 2 as a separate phase, so it is a method rather than a query somebody
   * writes by hand once and loses.
   */
  async rateSince(
    ctx: RlsContext,
    companyId: string,
    since: Date,
  ): Promise<{
    refusals: number;
    punches: number;
    ratePercent: number;
    byReason: Record<string, number>;
  }> {
    const [refusals, punches, grouped] = await withRlsContext(
      this.prisma,
      ctx,
      (tx) =>
        Promise.all([
          tx.punchRefusal.count({
            where: { companyId, createdAt: { gte: since } },
          }),
          tx.punchRecord.count({ where: { capturedAt: { gte: since } } }),
          tx.punchRefusal.groupBy({
            by: ['reason'],
            where: { companyId, createdAt: { gte: since } },
            _count: { _all: true },
          }),
        ]),
    );

    const byReason: Record<string, number> = {};
    for (const row of grouped) {
      byReason[row.reason] = row._count._all;
    }

    return {
      refusals,
      punches,
      // Against punches **accepted** in the window, because in Phase 2 every refusal is also an
      // accepted punch — so this is the proportion that would stop being accepted, which is the
      // question the client is actually being asked.
      ratePercent:
        punches === 0 ? 0 : Number(((refusals / punches) * 100).toFixed(2)),
      byReason,
    };
  }
}
