import { checkGeofence } from './geofence.util';

/** A site a punch may be matched to: one the employee's assignment covers on the punch day. */
export interface CandidateSite {
  siteId: string;
  name?: string;
  latitude: number;
  longitude: number;
  geofenceRadiusMeters: number;
}

export interface SiteMatch {
  /** The in-range site nearest the punch, or — when none is in range — the nearest one at all. */
  site: CandidateSite;
  withinGeofence: boolean;
  distanceMeters: number;
}

/**
 * Which of the employee's sites a punch was made at (058 FR-007, FR-008, FR-009).
 *
 * Every candidate is judged by the same `checkGeofence` the single-site punch always used, with the
 * same accuracy allowance, so a one-site employee gets exactly the answer they got before 058.
 *
 * - Inside one or more fences: the nearest **of those** wins. Fences of a project's sites can
 *   overlap, and the punch belongs to the site whose centre it is closest to.
 * - Inside none: the nearest site overall, with `withinGeofence: false` — the evidence a refusal
 *   records ("5.5 km from Bundi – 2000").
 * - No candidates: `null`. The caller decides what that means (every covered site inactive).
 *
 * The accuracy allowance is the caller's to give or withhold: an unlocatable fix is passed without
 * one, exactly as the single-site check did.
 */
export function matchSite(
  punch: { latitude: number; longitude: number; accuracyMeters?: number },
  candidates: readonly CandidateSite[],
): SiteMatch | null {
  let nearest: SiteMatch | null = null;
  let nearestInRange: SiteMatch | null = null;
  for (const site of candidates) {
    const { withinGeofence, distanceMeters } = checkGeofence(punch, site);
    const judged = { site, withinGeofence, distanceMeters };
    if (!nearest || distanceMeters < nearest.distanceMeters) nearest = judged;
    if (
      withinGeofence &&
      (!nearestInRange || distanceMeters < nearestInRange.distanceMeters)
    ) {
      nearestInRange = judged;
    }
  }
  return nearestInRange ?? nearest;
}
