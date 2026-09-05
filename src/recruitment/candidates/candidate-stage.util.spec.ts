import { CandidateStage } from '@prisma/client';

import {
  allowedNextStages,
  canTransition,
  isActiveStage,
} from './candidate-stage.util';

describe('candidate-stage.util', () => {
  it('permits the recruiter-driven advances', () => {
    expect(
      canTransition(CandidateStage.applied, CandidateStage.shortlisted),
    ).toBe(true);
    expect(
      canTransition(CandidateStage.shortlisted, CandidateStage.interviewing),
    ).toBe(true);
    expect(
      canTransition(CandidateStage.interviewing, CandidateStage.selected),
    ).toBe(true);
  });

  it('rejects a skip transition', () => {
    expect(canTransition(CandidateStage.applied, CandidateStage.joined)).toBe(
      false,
    );
    expect(canTransition(CandidateStage.applied, CandidateStage.selected)).toBe(
      false,
    );
  });

  it('allows rejection from any active stage', () => {
    for (const stage of [
      CandidateStage.applied,
      CandidateStage.shortlisted,
      CandidateStage.interviewing,
      CandidateStage.selected,
    ]) {
      expect(canTransition(stage, CandidateStage.rejected)).toBe(true);
    }
  });

  it('treats terminal stages as having no next stage', () => {
    expect(allowedNextStages(CandidateStage.joined)).toEqual([]);
    expect(allowedNextStages(CandidateStage.rejected)).toEqual([]);
    expect(allowedNextStages(CandidateStage.no_show)).toEqual([]);
  });

  it('classifies active vs terminal stages', () => {
    expect(isActiveStage(CandidateStage.selected)).toBe(true);
    expect(isActiveStage(CandidateStage.joined)).toBe(false);
    expect(isActiveStage(CandidateStage.rejected)).toBe(false);
  });
});
