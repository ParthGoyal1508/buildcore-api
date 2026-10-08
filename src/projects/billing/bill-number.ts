import { Prisma } from '@prisma/client';

/**
 * `RA-01`, `RA-02` — the nth bill in a sequence.
 *
 * Lives here rather than in `BillPackageService`, which is where it was, because two different
 * things now produce a bill number and both must spell it the same way. A second formatter would
 * be two implementations of one convention, which is the shape of defect this module has already
 * paid for once.
 */
export function packageLabel(sequenceNo: number): string {
  return `RA-${String(sequenceNo).padStart(2, '0')}`;
}

/** What {@link packageLabel} produces, so a stored number can be read back into its sequence. */
const SEQUENCE = /^RA-(\d+)$/;

/**
 * The sequence inside a bill number, or null where the number is not one this module minted.
 *
 * Exported so a package can take its sequence **from the bill it holds** rather than counting
 * packages separately. Both counters spell themselves `RA-nn`, and 027 observed they read
 * identically in the ordinary case — but a bill raised on the sheet consumes a bill number and no
 * package sequence, after which they disagree, and on 2026-10-08 one screen said RA-04 and
 * another RA-06 about the same bill. The bill's number is the running account the counterparty
 * signs for, so it is the one that wins.
 */
export function sequenceOf(billNumber: string): number | null {
  const match = SEQUENCE.exec(billNumber);
  return match ? Number(match[1]) : null;
}

/**
 * The next running account bill number on one work order (027).
 *
 * ## Why this is derived from the bills rather than from a counter
 *
 * Two screens compose a subcontractor bill — the RA bill sheet and the 023 bill package — and until
 * 027 they numbered it two different ways. The package path minted `RA-nn` from
 * `BillPackage.sequenceNo`; the sheet asked a person to type one, with **no unique constraint on
 * `RABill.billNumber` to catch the overlap**. Typing `RA-01` on the sheet and then composing a
 * package on the same work order produced two bills with one number and nothing said so.
 *
 * Counting the bills themselves is what makes both paths agree: a package-composed bill is an
 * `RABill` row like any other, so the sheet sees it, and the package path calling this sees the
 * sheet's. `BillPackage.sequenceNo` keeps its own meaning — it identifies the *package*, and the
 * overlap messages still speak in it — and in the ordinary case where every bill on a work order
 * came through packages, the two read identically.
 *
 * ## Max, not count
 *
 * A bill deleted or composed before 027 leaves the count disagreeing with the numbers in use, and
 * re-issuing a number already printed on a document somebody holds is worse than a gap in the
 * series. Numbers this does not recognise — the free text the old field allowed, "123" among them —
 * are skipped rather than guessed at.
 *
 * ## Not atomic, and does not need to be
 *
 * Read-then-write inside the caller's transaction, like `nextSequenceNo` beside it. Two composes
 * racing on one work order would read the same maximum, and the unique constraint 027 adds refuses
 * the second — a 409 the caller retries, rather than the silent duplicate this replaces. The
 * atomic allocator (`CodeSeriesService`) is for codes that must never repeat across a whole
 * company; this one is scoped to a single work order's handful of bills.
 */
/**
 * The next running account bill number for a project's **client** (027).
 *
 * The same rule as {@link nextRaBillNumber} and for the same reason: two screens compose a client
 * bill — the bill sheet and the 023 bill package — and until 027 the sheet asked a person to type
 * one while the package path minted `RA-nn` from `BillPackage.sequenceNo`. `ClientBill` has carried
 * `@@unique([projectId, billNumber])` since 018, so the collision was refused rather than silent;
 * it was still a refusal nobody could have predicted, on a number nobody should have been inventing.
 *
 * Scoped to the project rather than to the client. A project has one client, so the package path's
 * `(projectId, direction, counterpartyKey)` sequence and this agree — and the unique constraint is
 * per project, so this is the scope that has to be right.
 *
 * A client's `RA-01` and a subcontractor's `RA-01` are different documents in different tables, and
 * both are correct: one is the first bill to the client, the other the first against that work
 * order. That is already how the package path numbers them.
 */
export async function nextClientBillNumber(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<string> {
  const existing = await tx.clientBill.findMany({
    where: { projectId },
    select: { billNumber: true },
  });
  return packageLabel(highestSequence(existing) + 1);
}

export async function nextRaBillNumber(
  tx: Prisma.TransactionClient,
  workOrderId: string,
): Promise<string> {
  const existing = await tx.rABill.findMany({
    where: { workOrderId },
    select: { billNumber: true },
  });
  return packageLabel(highestSequence(existing) + 1);
}

/** 0 when nothing in the set is a recognisable sequence number. */
function highestSequence(rows: { billNumber: string }[]): number {
  return rows.reduce((max, row) => {
    const match = SEQUENCE.exec(row.billNumber);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}
