import { checkGeofence, haversineDistanceMeters } from './geofence.util';

describe('geofence', () => {
  // Two well-known points ~1150 km apart; a wrong formula (or degrees/radians
  // confusion) misses by far more than the tolerance below.
  const mumbai = { latitude: 19.076, longitude: 72.8777 };
  const delhi = { latitude: 28.6139, longitude: 77.209 };

  it('measures a known long distance to within 0.5%', () => {
    const km = haversineDistanceMeters(mumbai, delhi) / 1000;
    expect(km).toBeGreaterThan(1145);
    expect(km).toBeLessThan(1170);
  });

  it('returns zero for identical points', () => {
    expect(haversineDistanceMeters(mumbai, mumbai)).toBeCloseTo(0, 6);
  });

  it('is symmetric', () => {
    expect(haversineDistanceMeters(mumbai, delhi)).toBeCloseTo(
      haversineDistanceMeters(delhi, mumbai),
      6,
    );
  });

  it('measures a short site-scale offset accurately', () => {
    // 0.0009° of latitude ≈ 100 m, the scale a geofence actually operates at.
    const near = {
      latitude: mumbai.latitude + 0.0009,
      longitude: mumbai.longitude,
    };
    const meters = haversineDistanceMeters(mumbai, near);
    expect(meters).toBeGreaterThan(95);
    expect(meters).toBeLessThan(105);
  });

  describe('checkGeofence', () => {
    const site = { ...mumbai, geofenceRadiusMeters: 200 };

    it('admits a punch inside the radius', () => {
      const result = checkGeofence(
        { latitude: mumbai.latitude + 0.0009, longitude: mumbai.longitude },
        site,
      );
      expect(result.withinGeofence).toBe(true);
    });

    it('flags a punch outside the radius', () => {
      const result = checkGeofence(
        { latitude: mumbai.latitude + 0.009, longitude: mumbai.longitude },
        site,
      );
      expect(result.withinGeofence).toBe(false);
      expect(result.distanceMeters).toBeGreaterThan(200);
    });

    it('treats the boundary as inside', () => {
      // Standing exactly on the configured edge must not depend on rounding.
      const result = checkGeofence(mumbai, {
        ...mumbai,
        geofenceRadiusMeters: 0,
      });
      expect(result.withinGeofence).toBe(true);
    });
  });
});

/**
 * The accuracy allowance (020 FR-012a, T003).
 *
 * The property that matters most is the **backward-compatible** one: a punch with no accuracy must
 * get exactly the verdict it got before this existed. Under the hard refusal of FR-013 a wrongly
 * widened fence accepts a punch from the wrong place, and a wrongly narrowed one costs somebody a
 * day — so both directions are asserted rather than one.
 */
describe('checkGeofence — the accuracy allowance (FR-012a)', () => {
  const site = {
    latitude: 19.076,
    longitude: 72.8777,
    geofenceRadiusMeters: 100,
  };

  /** A point roughly `metres` north of the site. 1 degree of latitude ≈ 111_320 m. */
  const northOf = (metres: number) => ({
    latitude: site.latitude + metres / 111_320,
    longitude: site.longitude,
  });

  it('is outside at 120 m with no accuracy reported', async () => {
    const { checkGeofence } = await import('./geofence.util');
    expect(checkGeofence(northOf(120), site).withinGeofence).toBe(false);
  });

  it('is inside at 120 m when the device reports 40 m accuracy', async () => {
    const { checkGeofence } = await import('./geofence.util');
    expect(
      checkGeofence({ ...northOf(120), accuracyMeters: 40 }, site)
        .withinGeofence,
    ).toBe(true);
  });

  it('is still outside at 200 m with 40 m accuracy', async () => {
    // The allowance widens the fence; it does not remove it.
    const { checkGeofence } = await import('./geofence.util');
    expect(
      checkGeofence({ ...northOf(200), accuracyMeters: 40 }, site)
        .withinGeofence,
    ).toBe(false);
  });

  it('treats an absent accuracy as zero, changing nothing', async () => {
    // Every client shipped today omits the field. If this were anything but zero, every existing
    // punch's verdict would move the day this deployed.
    const { checkGeofence } = await import('./geofence.util');
    const at = northOf(100);
    expect(checkGeofence(at, site).withinGeofence).toBe(
      checkGeofence({ ...at, accuracyMeters: 0 }, site).withinGeofence,
    );
  });

  it('keeps the boundary inclusive with an allowance', async () => {
    // The same reason the function was written inclusive: a verdict that depends on floating-point
    // rounding is not a defensible basis for marking somebody absent.
    const { checkGeofence } = await import('./geofence.util');
    const result = checkGeofence({ ...northOf(140), accuracyMeters: 40 }, site);
    expect(result.distanceMeters).toBeLessThanOrEqual(141);
    expect(result.withinGeofence).toBe(true);
  });

  it('reports the real distance, not the allowed one', async () => {
    // The distance is evidence and goes on the record. Adjusting it by the allowance would put a
    // fiction in the audit trail.
    const { checkGeofence } = await import('./geofence.util');
    const result = checkGeofence({ ...northOf(120), accuracyMeters: 40 }, site);
    expect(result.distanceMeters).toBeGreaterThan(115);
    expect(result.distanceMeters).toBeLessThan(125);
  });
});
