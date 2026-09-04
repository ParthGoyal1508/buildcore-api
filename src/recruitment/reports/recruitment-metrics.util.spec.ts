import { CandidateStage } from '@prisma/client';

import {
  attritionRate,
  averageTimeToHire,
  funnelConversions,
  tenureMonths,
  timeToHireDays,
} from './recruitment-metrics.util';

describe('recruitment-metrics.util', () => {
  it('computes time-to-hire from applied to joined', () => {
    const history = [
      { toStage: CandidateStage.applied, occurredAt: new Date('2026-01-01') },
      {
        toStage: CandidateStage.shortlisted,
        occurredAt: new Date('2026-01-05'),
      },
      { toStage: CandidateStage.joined, occurredAt: new Date('2026-01-21') },
    ];
    expect(timeToHireDays(history)).toBe(20);
  });

  it('returns null time-to-hire without a joined row', () => {
    const history = [
      { toStage: CandidateStage.applied, occurredAt: new Date('2026-01-01') },
    ];
    expect(timeToHireDays(history)).toBeNull();
  });

  it('averages defined time-to-hire values', () => {
    expect(averageTimeToHire([10, 20, null])).toBe(15);
    expect(averageTimeToHire([null])).toBeNull();
  });

  it('computes attrition rate as a percentage of headcount', () => {
    expect(attritionRate(5, 100)).toBe(5);
    expect(attritionRate(0, 0)).toBe(0);
  });

  it('computes whole-month tenure', () => {
    expect(tenureMonths(new Date('2025-01-15'), new Date('2026-01-15'))).toBe(
      12,
    );
  });

  it('computes stage-to-stage conversions', () => {
    const conversions = funnelConversions(
      { applied: 100, shortlisted: 40, interviewing: 20 },
      [
        CandidateStage.applied,
        CandidateStage.shortlisted,
        CandidateStage.interviewing,
      ],
    );
    expect(conversions[0].percent).toBe(40);
    expect(conversions[1].percent).toBe(50);
  });
});
