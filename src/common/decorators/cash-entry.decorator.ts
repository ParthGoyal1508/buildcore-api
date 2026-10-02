import { SetMetadata } from '@nestjs/common';

export const REQUIRES_CASH_ENTRY_KEY = 'requiresCashEntry';

/**
 * Declares a route that records a cash payment **without the caller naming the mode**
 * (019 FR-017a).
 *
 * `CashEntryInterceptor` finds cash in a request body, which covers every cash write this
 * product has: both of them take the payment mode as a required field, so a cash payment
 * cannot be recorded without `paymentMode: 'cash'` arriving on the wire. That is what makes
 * the gate complete rather than a list somebody maintains.
 *
 * It stops being complete the moment a route derives the mode on the server — a sheet whose
 * mode comes from its own type, an import that defaults to cash. Such a route would pass the
 * body check holding nothing, because there is nothing in the body to find. This decorator is
 * how that route says so, and `cash-entry-surface.spec.ts` fails on any server-side cash write
 * that does not carry it.
 *
 * **Deliberately unused today**, and the spec test asserts the condition that makes it unused:
 * no service writes a cash mode that did not come from a request. Deleting it would leave the
 * next such route silently unguarded, which is the one failure this phase exists to prevent.
 */
export const RequiresCashEntry = () =>
  SetMetadata(REQUIRES_CASH_ENTRY_KEY, true);
