/**
 * Great-circle distance for geofence validation (research.md §3).
 *
 * Deliberately a plain formula rather than PostGIS: this feature needs exactly one
 * point-to-point distance per punch, never a spatial query, and adopting a
 * geospatial extension for that would be a new architectural dependency requiring
 * its own constitution amendment to buy nothing.
 */

/** Mean Earth radius in metres (WGS-84 mean). */
const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Haversine distance in metres between two lat/lng points.
 *
 * Haversine rather than the simpler equirectangular approximation because the
 * latter's error grows with latitude, and "close enough near the equator" is not a
 * property worth relying on for a check that decides whether someone gets paid for
 * a shift. At site-radius scale (metres to a few km) Haversine's own error against
 * an ellipsoidal model is well under a metre — far inside any sane geofence radius.
 */
export function haversineDistanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLng = toRadians(to.longitude - from.longitude);
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.sin(deltaLng / 2) ** 2 * Math.cos(fromLat) * Math.cos(toLat);

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface GeofenceCheck {
  withinGeofence: boolean;
  distanceMeters: number;
}

/**
 * Whether a punch's coordinates fall inside a site's geofence.
 *
 * The boundary is inclusive (distance ≤ radius): a worker standing exactly on the
 * configured edge is inside it. The alternative makes the verdict at the boundary
 * depend on floating-point rounding, which is not a defensible reason to mark
 * someone's attendance an exception.
 */
export function checkGeofence(
  punch: { latitude: number; longitude: number },
  site: { latitude: number; longitude: number; geofenceRadiusMeters: number },
): GeofenceCheck {
  const distanceMeters = haversineDistanceMeters(punch, site);
  return {
    withinGeofence: distanceMeters <= site.geofenceRadiusMeters,
    distanceMeters,
  };
}
