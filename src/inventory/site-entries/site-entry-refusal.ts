import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * Why a site entry was refused (043), with stable codes for the page to branch on. The location
 * reasons are the attendance punch's, worded as its messages are, for the same person holding the
 * same phone (`labour-punch-refusal.ts`).
 */
const LOCATION = {
  outside_geofence: {
    code: 'SITE_ENTRY_REFUSED_LOCATION',
    message:
      'You are too far from this site for the delivery to be recorded. Move to the site and try again.',
  },
  unlocatable: {
    code: 'SITE_ENTRY_REFUSED_UNLOCATABLE',
    message:
      'Your phone could not work out where you are accurately enough. Step outside or somewhere with a clearer view of the sky, then try again.',
  },
  stale_capture: {
    code: 'SITE_ENTRY_REFUSED_STALE_PHOTO',
    message:
      'This photo was taken too long ago. Take the photo again, then submit straight away.',
  },
} as const;

export type SiteEntryRefusal = keyof typeof LOCATION;

/** 422, as the punch refusals are: a well-formed request that could not be accepted on its own terms. */
export function siteEntryRefused(
  reason: SiteEntryRefusal,
  detail: Record<string, unknown> = {},
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    ...LOCATION[reason],
    reason,
    ...detail,
  });
}

/** 403 for a caller with no store to record against — HR assigns the sites. */
export function noStoreAssigned(): ForbiddenException {
  return new ForbiddenException({
    code: 'SITE_ENTRY_NO_STORE',
    message:
      'No store is assigned to you, so a delivery cannot be recorded. Ask the HR office to assign your site.',
  });
}
