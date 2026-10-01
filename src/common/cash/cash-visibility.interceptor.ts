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

    const companyId = user?.selectedCompanyId ?? user?.companyId ?? null;
    if (!companyId) return next.handle();

    const company = await withRlsContext(
      this.prisma,
      { isSuperAdmin: true },
      (tx) =>
        tx.company.findUnique({
          where: { id: companyId },
          select: { hideCashTransactions: true },
        }),
    );
    if (!company?.hideCashTransactions) return next.handle();

    return next.handle().pipe(map((body) => hideCash(body)));
  }
}

/**
 * Walks a response and hides what is cash.
 *
 * Recursive over arrays and plain objects, and deliberately conservative about what it treats as
 * one: a `Date`, a `Buffer` or a Prisma `Decimal` must be returned untouched, or hiding a
 * figure would corrupt every timestamp beside it.
 */
export function hideCash(value: unknown, rowIsCash = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => hideCash(item, rowIsCash));
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
    if (UNCONDITIONAL_CASH_FIELDS.includes(key) && child !== null) {
      // Cash by construction: a note-count breakup exists only for cash.
      out[key] = null;
      hidAnything = true;
      continue;
    }
    if (cash && CASH_AMOUNT_FIELDS.includes(key) && child !== null) {
      out[key] = null;
      hidAnything = true;
      continue;
    }
    out[key] = hideCash(child, cash);
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
