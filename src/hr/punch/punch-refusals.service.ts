import { Injectable, Logger } from '@nestjs/common';
import { PunchRefusalReason, PunchType } from '@prisma/client';
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
