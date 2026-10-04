import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { PrismaService } from 'nestjs-prisma';

import { AuthenticatedUser } from '../../auth/authenticated-user';
import { withRlsContext } from '../prisma/rls-context';
import { maySeeCashBreakup } from './cash-entry.interceptor';
import {
  CASH_AMOUNT_FIELDS,
  CASH_MODE_FIELDS,
  UNCONDITIONAL_CASH_FIELDS,
  isCashMode,
} from './cash-surfaces';

/**
 * Hides cash amounts when the company has asked for them hidden (019 FR-014, FR-015, FR-017).
 *
 * **Shapes the response; never touches a query or a row.** FR-017 is explicit that hiding is a
 * display control and not a data operation, so this is the only honest place for it: a filter in
 * the query layer would change what is stored-adjacent, and a check in each service would be the
 * same condition written thirty times with one of them wrong.
 *
 * A hidden amount becomes `null` with `amountHidden: true` beside it — **never zero**. A zero is
 * a figure, and neither a reader nor a spreadsheet summing a column can tell a hidden amount
 * from a real one; marking it is what stops an export silently understating a total by the value
 * of every cash payment in it.
 *
 * **The denomination breakup is the one exception, and it is a holder exception** (FR-017d, added
 * 2026-10-02). It stays hidden from everyone except a caller holding `CASH_ENTRY`. Hiding a note
 * count from the cashier who has to count the notes against it conceals nothing from anybody it
 * was meant to conceal from, while making the screen's only purpose unreachable. Amounts are not
 * treated the same way: a cashier needs the breakup to pay out, and needs no view of what every
 * other cash payment in the company came to.
 */
@Injectable()
export class CashVisibilityInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();

    const { hidden, maySeeBreakup } = await cashHidingFor(this.prisma, user);
    if (!hidden) return next.handle();

    return next
      .handle()
      .pipe(map((body) => hideCash(body, false, maySeeBreakup)));
  }
}

/**
 * Whether this caller's company has asked for cash hidden, and whether they still see the breakup.
 *
 * Exported because **a response sent through `@Res()` never reaches this interceptor.** Nest's
 * response-mapping pipe runs on what a handler returns, and a handler that writes to the raw
 * response returns nothing — so every file download in this product is outside the interceptor's
 * reach by construction. An export that silently understated a total by every cash payment in it
 * would be worse than one that says a figure is hidden, so those surfaces ask this directly rather
 * than each re-deriving the rule (Principle III).
 */
export async function cashHidingFor(
  prisma: PrismaService,
  user?: AuthenticatedUser,
): Promise<{ hidden: boolean; maySeeBreakup: boolean }> {
  const companyId = user?.selectedCompanyId ?? user?.companyId ?? null;
  if (!companyId) return { hidden: false, maySeeBreakup: false };

  const company = await withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
    tx.company.findUnique({
      where: { id: companyId },
      select: { hideCashTransactions: true },
    }),
  );
  // Hiding off means nothing is hidden, the breakup included. The company setting is the master
  // control (FR-014); `CASH_ENTRY` decides who still sees the breakup once it is on, not who sees
  // it when nobody asked for anything to be hidden.
  if (!company?.hideCashTransactions) {
    return { hidden: false, maySeeBreakup: false };
  }
  return {
    hidden: true,
    maySeeBreakup: user ? maySeeCashBreakup(user) : false,
  };
}

/**
 * Walks a response and hides what is cash.
 *
 * Recursive over arrays and plain objects, and deliberately conservative about what it treats as
 * one: a `Date`, a `Buffer` or a Prisma `Decimal` must be returned untouched, or hiding a
 * figure would corrupt every timestamp beside it.
 */
export function hideCash(
  value: unknown,
  rowIsCash = false,
  maySeeBreakup = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => hideCash(item, rowIsCash, maySeeBreakup));
  }
  if (!isPlainObject(value)) return value;

  const row = value as Record<string, unknown>;
  // A row is cash if it says so, or if its parent said so — a disbursement's lines inherit the
  // sheet's mode, and hiding the total while leaving the lines would hide nothing at all.
  const cash =
    rowIsCash || CASH_MODE_FIELDS.some((field) => isCashMode(row[field]));

  const out: Record<string, unknown> = {};
  let hidAnything = false;

  for (const [key, child] of Object.entries(row)) {
    if (
      UNCONDITIONAL_CASH_FIELDS.includes(key) &&
      child !== null &&
      !maySeeBreakup
    ) {
      // Cash by construction: a note-count breakup exists only for cash. `null` and not an
      // empty breakup or a zeroed one — a denomination count of zero reads as a real count of
      // no notes, which is a different and false statement.
      out[key] = null;
      hidAnything = true;
      continue;
    }
    if (cash && CASH_AMOUNT_FIELDS.includes(key) && child !== null) {
      out[key] = null;
      hidAnything = true;
      continue;
    }
    out[key] = hideCash(child, cash, maySeeBreakup);
  }

  if (hidAnything) {
    // Flagged, so the interface renders "hidden" rather than a blank, and an export's column is
    // present and marked rather than dropped.
    out.amountHidden = true;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  // Only literal objects and null-prototype ones. A Date, a Buffer or a Prisma Decimal has its
  // own prototype and must survive untouched — corrupting every timestamp in a response while
  // hiding one amount would be a far worse bug than the one this prevents.
  return proto === Object.prototype || proto === null;
}
