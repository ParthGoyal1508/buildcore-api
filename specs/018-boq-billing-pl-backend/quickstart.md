# Quickstart: BOQ, Billing and P&L (018, backend)

**Date**: 2026-09-16 · Ten validation passes. Passes 1–8 are automatable; 9 and 10 are the gates.

## Pass 1 — A bill cannot be raised without a BOQ

Attempt a client bill on a project with no BOQ task items. Expect `BOQ_REQUIRED` naming the missing
BOQ (FR-001 scenario 5). A bill that silently totals zero is worse than a refusal.

## Pass 2 — The bill totals from quantity × rate, and the rate freezes

Raise a bill for 100 units at ₹250. Confirm ₹25,000. **Then revise the BOQ rate to ₹300 and re-read
the submitted bill**: it must still say ₹25,000. This is FR-002 scenario 4 and the most important
assertion in the feature — a bill that re-prices itself means the company cannot say what it claimed.

## Pass 3 — Cumulative billed quantity is right after two bills

Bill 40 of 100, then 30 of 100. The second composition must show 40 already billed before the new
quantity is entered, and 70 after. Verify against the database, not the response.

## Pass 4 — Over-billing is flagged at entry and refused at submit

Enter 80 against a line with 70 remaining. The line comes back flagged and the bill **saves**.
Submitting without a reason is refused with `BILL_DEVIATION_REASON_REQUIRED`; with one it succeeds.
Refusing the keystroke instead would make a twenty-line bill undraftable (research §5).

## Pass 5 — An RA bill shows this period, to date, and remaining

Against a work order awarding 500 units, enter two bills of 120. The second must show 120 to date and
380 remaining **before** the new quantity is entered.

## Pass 6 — Editing an approved RA bill invalidates its approval

Approve an RA bill through 016, then edit a quantity. The prior approval must not survive: a recorded
decision describing numbers the approver never saw is worse than making them approve again (FR-009).

## Pass 7 — Every cost figure traces to source records

For a project with client bills, RA bills, payment sheets and material issues in one month, open each
cost figure and confirm the listed source records sum to it (FR-012). A figure that cannot be opened
is a figure nobody can defend in a review.

## Pass 8 — A module that has not registered is NAMED, not zeroed

Disable a registered cost source and re-read the summary. Its category must appear in
`unavailableModules`, not as a zero. "We asked and there is none" and "we could not ask" are
different answers and a director acts differently on each.

## Pass 9 — The group total equals the sum of its rows

Open the group view. Add the project rows by hand. They must equal the company total **exactly**.
This is the pass that catches a second aggregate query having been introduced (research §7), and it
is worth doing by hand because the failure it catches is arithmetic that looks plausible.

## Pass 10 — RLS, proven and not vacuous

Run the RLS e2e under a `NOSUPERUSER NOBYPASSRLS` probe. Then **disable one policy and confirm the
hidden rows appear**, and restore it. Without that second half, an empty table, a missing grant and a
typo in a table name all produce a passing isolation test — which is what made every pre-016 RLS test
in this repository vacuous.
