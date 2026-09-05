import { CandidateStage } from '@prisma/client';

/**
 * Recruitment funnel and attrition math (011 FR-027, FR-028). Pure, unit-tested
 * directly.
 */

/** Days between the first `applied` history row and the `joined` row, per candidate. */
export function timeToHireDays(
  history: { toStage: CandidateStage; occurredAt: Date }[],
): number | null {
  const applied = history.find((h) => h.toStage === CandidateStage.applied);
  const joined = history.find((h) => h.toStage === CandidateStage.joined);
  const start = applied?.occurredAt ?? history[0]?.occurredAt;
  if (!start || !joined) return null;
  const ms = joined.occurredAt.getTime() - start.getTime();
  return Math.max(0, Math.round(ms / (24 * 60 * 60 * 1000)));
}

/** Average of the defined time-to-hire values, or null when none. */
export function averageTimeToHire(values: (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null);
  if (defined.length === 0) return null;
  const sum = defined.reduce((a, b) => a + b, 0);
  return Math.round((sum / defined.length) * 10) / 10;
}

/** Attrition rate for a period: separations as a percentage of average headcount. */
export function attritionRate(
  separations: number,
  averageHeadcount: number,
): number {
  if (averageHeadcount <= 0) return 0;
  return Math.round((separations / averageHeadcount) * 10000) / 100;
}

/** Tenure in whole months between two dates. */
export function tenureMonths(from: Date, to: Date): number {
  const months =
    (to.getFullYear() - from.getFullYear()) * 12 +
    (to.getMonth() - from.getMonth());
  return Math.max(0, months);
}

/** Stage-to-stage conversion percentages down an ordered funnel. */
export function funnelConversions(
  stageCounts: Record<string, number>,
  order: CandidateStage[],
): { from: string; to: string; percent: number }[] {
  const out: { from: string; to: string; percent: number }[] = [];
  for (let i = 0; i < order.length - 1; i += 1) {
    const from = order[i];
    const to = order[i + 1];
    const fromCount = stageCounts[from] ?? 0;
    const toCount = stageCounts[to] ?? 0;
    out.push({
      from,
      to,
      percent:
        fromCount > 0 ? Math.round((toCount / fromCount) * 10000) / 100 : 0,
    });
  }
  return out;
}
