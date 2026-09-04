import { roundMoney } from './wage-calc.util';

/**
 * Cash denomination breakup for a payment sheet (013 FR-027).
 *
 * A greedy minimal-note-count split: for each worker's net payable, take as many of
 * the largest denomination as fit, then the next, and so on. Whatever cannot be
 * expressed in the available notes is the worker's residual, reported per worker and
 * carried forward to the next period rather than silently rounded away (FR-027, and
 * the spec's "denominations do not cover a worker's exact net" edge case).
 *
 * Denominations arrive descending (CompaniesService.getLabourSettings sorts them),
 * so the greedy pass is optimal for a canonical currency system.
 */

export interface WorkerNet {
  workerId: string;
  netPayable: number;
}

export interface WorkerResidual {
  workerId: string;
  residual: number;
}

export interface DenominationBreakup {
  /** Note count keyed by denomination value, only non-zero entries. */
  notes: Record<number, number>;
  /** Total notes across all denominations. */
  totalNotes: number;
  /** Sum actually expressible in notes. */
  expressibleTotal: number;
  /** Per-worker residual that could not be expressed in the available notes. */
  residuals: WorkerResidual[];
}

/**
 * Computes the aggregate note count for the whole sheet plus each worker's residual.
 *
 * The note count is aggregated across the sheet (that is what the cashier physically
 * counts against), while the residual is per worker (each worker's own carry-forward,
 * FR-027). A worker whose net is fully expressible has no residual entry.
 */
export function computeDenominationBreakup(
  workers: WorkerNet[],
  denominations: number[],
): DenominationBreakup {
  const notes: Record<number, number> = {};
  const residuals: WorkerResidual[] = [];
  let expressibleTotal = 0;

  const denoms = [...denominations].filter((d) => d > 0).sort((a, b) => b - a);

  for (const worker of workers) {
    // Work in integer paise to avoid binary-float drift when the smallest
    // denomination is ₹1 but net payable carries paise.
    let remainingPaise = Math.round(worker.netPayable * 100);

    for (const denom of denoms) {
      const denomPaise = denom * 100;
      if (remainingPaise < denomPaise) continue;
      const count = Math.floor(remainingPaise / denomPaise);
      notes[denom] = (notes[denom] ?? 0) + count;
      remainingPaise -= count * denomPaise;
      expressibleTotal += (count * denomPaise) / 100;
    }

    if (remainingPaise > 0) {
      residuals.push({
        workerId: worker.workerId,
        residual: roundMoney(remainingPaise / 100),
      });
    }
  }

  const totalNotes = Object.values(notes).reduce((sum, n) => sum + n, 0);

  return {
    notes,
    totalNotes,
    expressibleTotal: roundMoney(expressibleTotal),
    residuals,
  };
}
