import { CandidateStage } from '@prisma/client';

/**
 * The candidate stage machine (011 FR-004). Pure and Prisma-free so it is unit
 * tested directly and is the single definition both the transition endpoint and the
 * board's client mirror.
 *
 * `offer_issued`, `offer_accepted` and `joined` are reached through the offer and
 * joining flows, not a manual stage PATCH, so they are not manual targets here —
 * only the recruiter-driven advances and the reject/no-show terminals are. Reaching
 * `selected` additionally requires every scheduled round complete with a final
 * recommendation; that is a service check on top of this machine.
 */
const TRANSITIONS: Record<CandidateStage, CandidateStage[]> = {
  applied: [CandidateStage.shortlisted, CandidateStage.rejected],
  shortlisted: [CandidateStage.interviewing, CandidateStage.rejected],
  interviewing: [CandidateStage.selected, CandidateStage.rejected],
  selected: [CandidateStage.rejected],
  offer_issued: [CandidateStage.rejected],
  offer_accepted: [CandidateStage.no_show, CandidateStage.rejected],
  joined: [],
  rejected: [],
  no_show: [],
};

/** The stages a candidate may move to next from `stage` via a manual transition. */
export function allowedNextStages(stage: CandidateStage): CandidateStage[] {
  return TRANSITIONS[stage] ?? [];
}

/** Whether a manual transition from `from` to `to` is permitted. */
export function canTransition(
  from: CandidateStage,
  to: CandidateStage,
): boolean {
  return allowedNextStages(from).includes(to);
}

/** The stages that still count as an active pipeline (not terminal). */
export const ACTIVE_STAGES: CandidateStage[] = [
  CandidateStage.applied,
  CandidateStage.shortlisted,
  CandidateStage.interviewing,
  CandidateStage.selected,
  CandidateStage.offer_issued,
  CandidateStage.offer_accepted,
];

export function isActiveStage(stage: CandidateStage): boolean {
  return ACTIVE_STAGES.includes(stage);
}
