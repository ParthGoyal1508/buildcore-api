import { billTotals, lineTotals, money, retentionOn } from './bill-totals';

/**
 * The arithmetic every bill and the P&L share (018 FR-002, FR-003, FR-008 — tasks T003, T011, T019).
 *
 * **Two implementations of "net" is this feature's worst defect and it would not announce itself** —
 * the figures would differ slightly on two screens and each would look plausible. This spec is what
 * makes there be one.
 */

describe('a line is priced at its frozen rate and the quoted percentage', () => {
  it('multiplies quantity by rate', () => {
    expect(lineTotals({ quantity: 10, rate: 251 }).amount).toBe(2510);
  });

  it('applies the quoted percentage the client’s BOQ actually carries', () => {
    // From `docs/BOQ_794578.xls`: a government "Percentage BoQ" where the bidder quotes one percentage
    // against the schedule rather than a rate per line — `Excess (+) 0.0246`.
    const { amount } = lineTotals({ quantity: 825.7287, rate: 251 }, 0.0246);
    // 825.7287 × 251 = 207,257.90 — the figure in the file's own TOTAL AMOUNT column — and +2.46%
    // takes it to 212,356.45.
    expect(amount).toBe(212356.45);
  });

  it('under-bills by the percentage if it is forgotten', () => {
    // The whole reason the column exists, asserted as a difference rather than described in a comment.
    // On the client's own file this gap is ₹7.37 lakh on ₹3 crore: invisible per line, material in
    // total, which is the worst shape a billing error takes.
    const withQuote = lineTotals({ quantity: 825.7287, rate: 251 }, 0.0246);
    const without = lineTotals({ quantity: 825.7287, rate: 251 });
    expect(withQuote.amount).toBeGreaterThan(without.amount);
    expect(money(withQuote.amount - without.amount)).toBe(5098.55);
  });

  it('handles a Less (-) quote, which the same column carries', () => {
    expect(lineTotals({ quantity: 100, rate: 100 }, -0.05).amount).toBe(9500);
  });

  it('prices at par when nothing was quoted', () => {
    // The default, and the safe one: it prices from the schedule exactly.
    expect(lineTotals({ quantity: 100, rate: 100 }, 0).amount).toBe(10000);
  });
});

describe('cumulative quantity and scope (FR-003)', () => {
  it('adds this bill’s quantity to what came before', () => {
    const { cumulativeQty } = lineTotals({
      quantity: 40,
      rate: 100,
      previouslyBilledQty: 60,
    });
    expect(cumulativeQty).toBe(100);
  });

  it('flags over-measurement rather than refusing it', () => {
    // Over-measurement happens on real sites and is often correct. Refusing it at entry means the
    // measurement never gets recorded anywhere — the refusal belongs at submit, without a reason.
    const line = lineTotals({
      quantity: 20,
      rate: 100,
      previouslyBilledQty: 90,
      scopeQty: 100,
    });
    expect(line.exceedsScope).toBe(true);
    expect(line.amount).toBe(2000);
  });

  it('reports remaining as negative when over, rather than clamping to zero', () => {
    // "0 remaining" and "10 over" are different facts, and a clamp hides the second behind the first.
    const line = lineTotals({
      quantity: 20,
      rate: 100,
      previouslyBilledQty: 90,
      scopeQty: 100,
    });
    expect(line.remainingQty).toBe(-10);
  });

  it('does not flag measuring exactly to scope', () => {
    const line = lineTotals({
      quantity: 10,
      rate: 100,
      previouslyBilledQty: 90,
      scopeQty: 100,
    });
    expect(line.exceedsScope).toBe(false);
    expect(line.remainingQty).toBe(0);
  });

  it('flags nothing when there is no scope to compare against', () => {
    // A subcontract line that the client's BOQ itemises differently has no scope here, and must not
    // read as over-measured for the lack of one.
    expect(lineTotals({ quantity: 1000, rate: 1 }).exceedsScope).toBe(false);
  });

  it('measures quantity to three places, as the schema does', () => {
    const line = lineTotals({
      quantity: 0.0005,
      rate: 100,
      previouslyBilledQty: 1,
    });
    expect(line.cumulativeQty).toBe(1.001);
  });
});

describe('a bill’s totals, and the four-way distinction', () => {
  const lines = [
    lineTotals({ quantity: 10, rate: 1000 }),
    lineTotals({ quantity: 5, rate: 2000 }),
  ];

  it('sums the line amounts rather than recomputing from quantities', () => {
    // The lines are what the document shows. A total derived independently can disagree with the rows
    // above it by a rounding step, and a client who adds up the column stops trusting the document.
    expect(billTotals(lines).gross).toBe(20000);
  });

  it('shows each deduction in its own right (FR-008)', () => {
    // Not one net figure: a subcontractor disputing a payment asks which deduction accounts for the
    // difference, and a single `net` cannot answer.
    const totals = billTotals(lines, {
      retention: 1000,
      advanceRecovery: 500,
      other: 250,
    });
    expect(totals).toMatchObject({
      gross: 20000,
      retention: 1000,
      advanceRecovery: 500,
      otherDeductions: 250,
      deductionTotal: 1750,
      net: 18250,
    });
  });

  it('reports the P&L amount as gross, never net', () => {
    // **The distinction this file exists for.** Retention is money withheld and an advance recovery is
    // money already paid; neither is spend. A P&L that treated net as cost would understate the
    // project by every rupee of retention held across it.
    const totals = billTotals(lines, { retention: 1000, advanceRecovery: 500 });
    expect(totals.pnlAmount).toBe(20000);
    expect(totals.pnlAmount).not.toBe(totals.net);
  });

  it('floors net at zero but leaves the deductions at full value', () => {
    // Deductions exceeding gross is a data problem. A negative "what changes hands" would be read as
    // money flowing the other way; leaving the deductions visible keeps the inconsistency apparent
    // rather than absorbing it.
    const totals = billTotals(lines, { retention: 25000 });
    expect(totals.net).toBe(0);
    expect(totals.retention).toBe(25000);
  });

  it('carries the over-scope flag up from any line', () => {
    // A summary that quietly totals a bill containing an over-quantity line is arithmetically right
    // and materially misleading — it reports revenue against scope that was never awarded.
    const flagged = [
      lineTotals({ quantity: 10, rate: 100 }),
      lineTotals({
        quantity: 20,
        rate: 100,
        previouslyBilledQty: 90,
        scopeQty: 100,
      }),
    ];
    expect(billTotals(flagged).exceedsScope).toBe(true);
  });

  it('totals an empty bill to zero rather than NaN', () => {
    expect(billTotals([])).toMatchObject({ gross: 0, net: 0, pnlAmount: 0 });
  });
});

describe('retentionOn', () => {
  it('computes retention on gross', () => {
    expect(retentionOn(100000, 0.05)).toBe(5000);
  });

  it('rounds to paise', () => {
    expect(retentionOn(33333.33, 0.05)).toBe(1666.67);
  });

  it('is zero at a zero fraction', () => {
    expect(retentionOn(100000, 0)).toBe(0);
  });
});
