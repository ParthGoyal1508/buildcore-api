import { CandidateSite, matchSite } from './site-match';

/**
 * 058: a punch matched across the sites an assignment covers. Coordinates near Bundi; 0.001° of
 * latitude is ~111 m.
 */
const A: CandidateSite = {
  siteId: 'A',
  latitude: 25.4,
  longitude: 75.7,
  geofenceRadiusMeters: 200,
};
/** ~2.2 km north of A — far enough that the two fences never touch. */
const B: CandidateSite = { ...A, siteId: 'B', latitude: 25.42 };
/** ~150 m north of A: its fence overlaps A's. */
const C: CandidateSite = { ...A, siteId: 'C', latitude: 25.40135 };

const at = (latitude: number, accuracyMeters?: number) => ({
  latitude,
  longitude: 75.7,
  accuracyMeters,
});

describe('matchSite (058)', () => {
  it('matches a punch inside A to A', () => {
    const match = matchSite(at(25.4001), [A, B]);
    expect(match).toMatchObject({
      site: { siteId: 'A' },
      withinGeofence: true,
    });
  });

  it('matches a punch inside B to B', () => {
    const match = matchSite(at(25.4199), [A, B]);
    expect(match).toMatchObject({
      site: { siteId: 'B' },
      withinGeofence: true,
    });
  });

  it('gives an overlap to the nearest centre', () => {
    // 90 m north of A, 60 m south of C: inside both fences.
    const match = matchSite(at(25.40081), [A, C]);
    expect(match?.site.siteId).toBe('C');
    expect(match?.withinGeofence).toBe(true);
  });

  it('prefers a site the punch is inside over a nearer centre it is outside', () => {
    // A small fence close by, a large fence further away that contains the punch.
    const tiny: CandidateSite = {
      ...A,
      siteId: 'tiny',
      geofenceRadiusMeters: 10,
    };
    const wide: CandidateSite = {
      ...A,
      siteId: 'wide',
      latitude: 25.401,
      geofenceRadiusMeters: 500,
    };
    // ~55 m from tiny's centre (outside its 10 m), ~55 m from wide's (inside its 500 m).
    const match = matchSite(at(25.4005), [tiny, wide]);
    expect(match?.site.siteId).toBe('wide');
    expect(match?.withinGeofence).toBe(true);
  });

  it('records the nearest site, and its distance, for a punch outside every fence', () => {
    // ~1.1 km north of A, ~1.1 km south of B, slightly nearer B.
    const match = matchSite(at(25.4101), [A, B]);
    expect(match?.site.siteId).toBe('B');
    expect(match?.withinGeofence).toBe(false);
    expect(match?.distanceMeters).toBeGreaterThan(1_000);
  });

  it('widens each fence by the accuracy it is given, as the single-site check did', () => {
    // ~250 m from A: outside 200 m, inside 200 m + 60 m of accuracy.
    expect(matchSite(at(25.40225), [A])?.withinGeofence).toBe(false);
    expect(matchSite(at(25.40225, 60), [A])?.withinGeofence).toBe(true);
  });

  it('gives a one-site employee exactly the single-site answer', () => {
    const match = matchSite(at(25.4001), [A]);
    expect(match?.site.siteId).toBe('A');
    expect(match?.withinGeofence).toBe(true);
  });

  it('has no answer without candidates', () => {
    expect(matchSite(at(25.4), [])).toBeNull();
  });
});
