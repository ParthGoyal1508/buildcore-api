/** The six display flags a document type can resolve to (spec US5 scenario 1). */
export type DocumentTypeFlag =
  | 'MandatoryNumber'
  | 'Mandatory'
  | 'ExpiryNumber'
  | 'Expiry'
  | 'Number'
  | 'Optional';

/**
 * Derives a document type's display flag from its three independent booleans.
 *
 * Computed on read, never stored (research.md §7): a stored copy could drift from
 * the booleans if a toggle were edited without recomputing it. The branch order
 * below *is* the specification — mandatory outranks expiry, and each pairing with
 * "needs number" is checked before the bare form.
 */
export function computeDocumentTypeFlag(
  isMandatory: boolean,
  hasExpiry: boolean,
  needsNumber: boolean,
): DocumentTypeFlag {
  if (isMandatory && needsNumber) return 'MandatoryNumber';
  if (isMandatory) return 'Mandatory';
  if (hasExpiry && needsNumber) return 'ExpiryNumber';
  if (hasExpiry) return 'Expiry';
  if (needsNumber) return 'Number';
  return 'Optional';
}
