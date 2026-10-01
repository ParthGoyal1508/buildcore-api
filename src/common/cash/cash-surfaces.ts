/**
 * Every place this product holds a cash amount (019 FR-014, FR-015, plan D6).
 *
 * One exported constant rather than a condition repeated per module (Principle III), and a
 * **closed list**, which is a liability: a module added later holds cash, nobody updates this,
 * and a figure appears on a screen somebody was told would hide it. `cash-surfaces.spec.ts`
 * parses `schema.prisma` and fails when a new enum grows a `cash` value that is not named here,
 * so the list going stale is a failing test rather than a promise quietly broken.
 *
 * Derived from research §4, which surveyed the schema:
 *
 * | Where | Why it is here |
 * |---|---|
 * | `PaymentMode.cash` on a payment | The general case |
 * | `LabourPaymentMode.cash` on a disbursement | Labour wage payouts |
 * | `LabourPaymentSheet.denominationBreakup` | Cash by construction — a note-count breakup exists only for cash |
 *
 * **`Company.labourCashDenominations` is deliberately absent.** It looks like cash and is not:
 * it is configuration — which notes are in circulation — and hiding it would break the payment
 * sheet builder while concealing nothing anybody wanted concealed.
 */

/** Enum values, anywhere in the schema, that mean "this amount was cash". */
export const CASH_ENUM_VALUES: readonly string[] = ['cash'];

/** The enums that carry a cash value, and therefore mark a row as a cash transaction. */
export const CASH_MODE_ENUMS: readonly string[] = [
  'PaymentMode',
  'LabourPaymentMode',
];

/**
 * Fields hidden when a row is a cash transaction, keyed by the mode field that decides it.
 *
 * `amountHidden` accompanies the nulled value rather than replacing it with zero: a zero is a
 * figure, and neither a reader nor a spreadsheet summing a column can tell a hidden amount from
 * a real one. Marking it is also what lets an export keep its shape — the column is present and
 * flagged, not dropped, because dropping it changes the shape of a file somebody's spreadsheet
 * depends on.
 */
export const CASH_AMOUNT_FIELDS: readonly string[] = [
  'amount',
  'netAmount',
  'grossAmount',
  'netTotal',
  'grossTotal',
  'paidAmount',
];

/** Fields that are cash by construction, hidden whatever the row's mode says. */
export const UNCONDITIONAL_CASH_FIELDS: readonly string[] = [
  'denominationBreakup',
];

/** The field names that say a row's payment mode. */
export const CASH_MODE_FIELDS: readonly string[] = ['paymentMode', 'mode'];

/** True when a value names a cash payment mode. */
export function isCashMode(value: unknown): boolean {
  return typeof value === 'string' && CASH_ENUM_VALUES.includes(value);
}
