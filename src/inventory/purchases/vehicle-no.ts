/**
 * A vehicle number as stored on a site entry (043): uppercase with every space removed, so
 * "mh 12 ab 1234" and "MH12 AB1234" are the same vehicle. Empty when nothing but spaces was typed.
 */
export function normaliseVehicleNo(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}
