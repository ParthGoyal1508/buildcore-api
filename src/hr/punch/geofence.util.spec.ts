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
