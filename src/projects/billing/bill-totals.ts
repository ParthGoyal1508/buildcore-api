/**
 * What gross, net, revenue and cost mean — in one place (018 FR-002, FR-003, FR-008).
 *
 * Pure, and separate from every service, because **two implementations of "net" is this feature's
 * worst defect and it would not announce itself.** The figures would simply differ slightly on two
 * screens and each would look plausible. A sheet summing three hundred lines is the worst place in the
 * product for that to happen.
 *
 * ## The four-way distinction, written once
 *
 * A bill has four money figures and only two of them are what most people mean by "the amount":
 *
 *   * **gross** — the work, at the frozen rates. This is revenue on a client bill and cost on a
 *     subcontractor's.
 *   * **retention** — money withheld against future obligations. On a client bill it is *the client's*
 *     money held back from us; on an RA bill it is *our* money held back from them. Either way it is
 *     **not a cost and not revenue**: it is a timing difference, and it is released later.
 *   * **advance recovery** — money already paid, coming back. Also **not a cost**: counting it would
 *     be counting the same rupee twice, once when the advance went out and once here.
 *   * **net** — what actually changes hands now.
 *
 * **A P&L that treats net as cost understates the project**, and one that treats gross as cash
 * overstates what has moved. A reader drilling from a summary's cost figure into bills can otherwise
 * land on a deduction line and conclude the project spent it. That is the mistake this file exists to
 * make impossible to reach by accident.
 */

/**
 * A number's exact decimal digits, as written: `1.005` is `{ digits: 1005n, scale: 3 }`.
 *
 * Read from the number's shortest round-trip string — the same digits a person typed and the same
 * digits `String(n)` prints — so `1.005` is 1.005 here, not the 1.00499999999999989… the float
 * actually holds. That gap is the whole of 036 I5.
 */
function decimalOf(value: number): { digits: bigint; scale: number } {
  const [mantissa, exponent = '0'] = String(Math.abs(value)).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  let digits = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - Number(exponent);
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { digits: value < 0 ? -digits : digits, scale };
}

/**
 * Rounds exact decimal digits to `places`, half away from zero — the rounding a person does by hand
 * and the one GST invoices use. `1.005 → 1.01`, `-1.005 → -1.01`, `2.675 → 2.68`.
 */
function roundDecimal(
  { digits, scale }: { digits: bigint; scale: number },
  places: number,
): number {
  if (scale <= places) {
    return Number(`${digits}e-${scale}`);
  }
  const divisor = 10n ** BigInt(scale - places);
  const negative = digits < 0n;
  const magnitude = negative ? -digits : digits;
  let quotient = magnitude / divisor;
  if ((magnitude % divisor) * 2n >= divisor) quotient += 1n;
  const rounded = Number(`${quotient}e-${places}`);
  return negative && rounded !== 0 ? -rounded : rounded;
}

/**
 * Half-up rounding to `places` on the number's written digits (036 I5).
 *
 * Replaces `Math.round(v * 100) / 100`, which rounds the *float*: `1.005 * 100` is `100.49999…`, so
 * ₹1.005 became ₹1.00 — while the bill package, which rounds `Prisma.Decimal`, made it ₹1.01, and
 * the two halves of one bill disagreed by a paisa a line. Pure and dependency-free on purpose: the
 * web's `app/lib/bill-totals.ts` mirrors this file and has no decimal library, so it can copy these
 * helpers verbatim and stay aligned.
 */
export function roundHalfUp(value: number, places: number): number {
  if (!Number.isFinite(value)) return value;
  return roundDecimal(decimalOf(value), places);
}

/**
 * `a × b × …`, multiplied on exact decimal digits and then rounded to `places`.
 *
 * A float product can land just under a half-paisa that the true product sits on — `10.05 × 0.5` is
 * `5.0249999…` as a float and 5.025 exactly — and no rounding of the float afterwards can recover the
 * digit that was lost. Multiplying the written digits cannot lose it.
 */
export function productRounded(places: number, ...factors: number[]): number {
  if (!factors.every(Number.isFinite)) return NaN;
  let digits = 1n;
  let scale = 0;
  for (const factor of factors) {
    const d = decimalOf(factor);
    digits *= d.digits;
    scale += d.scale;
  }
  return roundDecimal({ digits, scale }, places);
}

/** Two decimal places, half-up on the written digits — the rounding every money figure uses. */
export const money = (value: number): number => roundHalfUp(value, 2);

/** Three, matching the schema's quantity columns — a BOQ measures to the millimetre. */
export const quantity = (value: number): number => roundHalfUp(value, 3);

/**
 * Six, for a **rate the quote derives** rather than one anybody typed.
 *
 * A rate column is conventionally two decimals and two is wrong here. The reported bill is priced
 * at 10.79% below: ₹178.00 becomes ₹158.795380, and ₹158.80 × 37.25 is ₹5,915.30 against the
 * ₹5,915.07 the line was actually billed. A reader multiplying the rate beside the amount would
 * land twenty-three paise away from it and reasonably conclude one of the two was wrong — which is
 * the whole defect this figure exists to close, reintroduced by rounding it to look tidy.
 *
 * Not `money`, because this is not money: it is a price per unit, and only the product of it and a
 * quantity is ever paid.
 */
export const unitRate = (value: number): number => roundHalfUp(value, 6);

/** One line of a bill, before anything is summed. */
export interface BillLineInput {
  quantity: number;
  /** The frozen rate. Never read live from the BOQ — see `ClientBillLine.rate`. */
  rate: number;
  /** How much of this BOQ line every *other* bill has already measured. */
  previouslyBilledQty?: number;
  /** The BOQ's own scope quantity, where there is one to compare against. */
  scopeQty?: number;
}

export interface BillLineTotals {
  /** `quantity × rate × (1 + quotedPercentage)`. */
  amount: number;
  /** This bill's quantity plus every earlier bill's. */
  cumulativeQty: number;
  /** Scope less cumulative. Negative when over-measured — reported, not clamped. */
  remainingQty: number;
  /**
   * Whether cumulative measurement has passed the scope quantity (FR-003).
   *
   * **A flag, not a refusal.** Over-measurement happens on real sites and is often correct; refusing
   * it at entry means the measurement never gets recorded anywhere, which is worse than recording it
   * with a question against it. The refusal belongs at submit, and only without a stated reason.
   *
   * **Any consumer summing billed values must know this can happen.** A summary that quietly totals a
   * bill containing an over-quantity line is arithmetically right and materially misleading — it
   * reports revenue against scope that was never awarded.
   */
  exceedsScope: boolean;
}

/**
 * One line's figures.
 *
 * `quotedPercentage` is applied **here**, at the line, not once at the bill's total. The two give
 * different answers after rounding, and the per-line figure is the one that appears on the document a
 * client reads — so the total must be the sum of the printed lines rather than a separately-derived
 * number that is a rupee or two away from them.
 *
 * **`BillableBoq.quotedTotal` applies it once to the total, and that is not a contradiction.** It
 * reproduces the figure the tender document itself states, which is what the BOQ import reconciles
 * against. Two documents, two correct answers, differing by at most half a paisa a line — and
 * `test/client-bills.e2e-spec.ts` measures the gap rather than asserting it away. The first drafts of
 * this comment and of `billableBoq`'s each called the other's choice wrong.
 */
export function lineTotals(
  line: BillLineInput,
  quotedPercentage = 0,
): BillLineTotals {
  // On exact digits (036 I5): `1 + quotedPercentage` is itself exact for any percentage a person
  // typed (`1 + -0.1079` prints as `0.8921`), and the product is rounded once, at the end.
  const amount = productRounded(
    2,
    line.quantity,
    line.rate,
    roundHalfUp(1 + quotedPercentage, 12),
  );
  const cumulativeQty = quantity(
    (line.previouslyBilledQty ?? 0) + line.quantity,
  );
  const scope = line.scopeQty;
  return {
    amount,
    cumulativeQty,
    // Reported as negative rather than clamped at zero: "0 remaining" and "12 over" are different
    // facts, and a clamp hides the second behind the first.
    remainingQty: scope === undefined ? 0 : quantity(scope - cumulativeQty),
    exceedsScope: scope !== undefined && cumulativeQty > scope,
  };
}

/** The deductions a bill carries. Each named, because each is a different kind of thing. */
export interface BillDeductions {
  /** Withheld against future obligations. A timing difference, not a cost. */
  retention?: number;
  /** An advance coming back. Already counted when it went out. */
  advanceRecovery?: number;
  /** Anything else agreed. Named by the bill, not by this file. */
  other?: number;
}

export interface BillTotals {
  /** The work, at the frozen rates, with the quoted percentage applied per line. */
  gross: number;
  retention: number;
  advanceRecovery: number;
  otherDeductions: number;
  /** The three above, summed. Exposed so a screen need not re-add them. */
  deductionTotal: number;
  /** What changes hands now. */
  net: number;
  /**
   * What this bill contributes to the project's **cost or revenue** — which is `gross`, not `net`.
   *
   * Named separately from `gross` even though they are equal today, because the question "what did
   * this bill do to the P&L" is the one a reader actually asks, and answering it with a field called
   * `gross` invites the next person to reach for `net` instead. See the file docblock.
   */
  pnlAmount: number;
  /** True when any line is over its BOQ scope. See `BillLineTotals.exceedsScope`. */
  exceedsScope: boolean;
}

/**
 * A bill's figures from its lines and its deductions.
 *
 * The sum of **line amounts**, never a recomputation from quantities and rates: the lines are what the
 * document shows, and a total derived independently is a total that can disagree with the rows above
 * it by a rounding step. A client who adds up the column and gets a different answer stops trusting
 * the whole document.
 */
export function billTotals(
  lines: BillLineTotals[],
  deductions: BillDeductions = {},
): BillTotals {
  const gross = money(lines.reduce((sum, line) => sum + line.amount, 0));
  const retention = money(deductions.retention ?? 0);
  const advanceRecovery = money(deductions.advanceRecovery ?? 0);
  const otherDeductions = money(deductions.other ?? 0);
  const deductionTotal = money(retention + advanceRecovery + otherDeductions);
  return {
    gross,
    retention,
    advanceRecovery,
    otherDeductions,
    deductionTotal,
    // Floored at zero: deductions exceeding gross is a data problem, and a negative "what changes
    // hands" would be read as money flowing the other way. The deductions stay visible at their full
    // value, so the inconsistency is apparent rather than absorbed.
    net: money(Math.max(0, gross - deductionTotal)),
    pnlAmount: gross,
    exceedsScope: lines.some((line) => line.exceedsScope),
  };
}

/**
 * Retention as a figure, from a fraction and a gross.
 *
 * Here rather than inline at the two call sites, because retention is the deduction most likely to be
 * computed on the wrong base — on net, or on the previous bill's cumulative — and one function is one
 * place to be right.
 */
export function retentionOn(gross: number, fraction: number): number {
  return productRounded(2, gross, fraction);
}

/**
 * What a work order still holds back from its subcontractor (018 FR-016a).
 *
 * Pure, so the arithmetic that decides whether a release is allowed can be tested without a
 * database — and so the figure a screen shows and the figure the refusal is computed against are
 * produced by the same line of code rather than by two that agree today.
 *
 * **Withheld counts only bills that have left draft.** A draft is a working document whose
 * retention has not been withheld from anybody yet; counting it would let somebody release money
 * against a bill that may never be issued.
 */
export function retentionBalance(input: {
  withheld: number;
  released: number;
}): { withheld: number; released: number; outstanding: number } {
  const withheld = money(input.withheld);
  const released = money(input.released);
  return {
    withheld,
    released,
    // Never clamped at zero. A negative balance should be impossible — the release path refuses to
    // create one — so if it ever appears it is a defect worth seeing rather than hiding, and the
    // one place it could come from is a bill edited after its retention was released against.
    outstanding: money(withheld - released),
  };
}
