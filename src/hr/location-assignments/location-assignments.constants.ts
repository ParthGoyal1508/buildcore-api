/** Error and warning codes for staff location assignments and the site of a punch (058). */

/** Not mobile, and no site or project named. */
export const ASSIGNMENT_EMPTY = 'ASSIGNMENT_EMPTY';

/** Mobile and sites or projects at once: mobility is the absence of a place. */
export const ASSIGNMENT_MOBILE_WITH_TARGETS = 'ASSIGNMENT_MOBILE_WITH_TARGETS';

/**
 * A warning, not a refusal: the assignment is saved, and every punch under it is refused as outside
 * the geofence until the project has an active site.
 */
export const PROJECT_HAS_NO_ACTIVE_SITE = 'PROJECT_HAS_NO_ACTIVE_SITE';

/** A manual punch or correction named a site the employee is not assigned to on that day. */
export const SITE_NOT_ASSIGNED = 'SITE_NOT_ASSIGNED';
