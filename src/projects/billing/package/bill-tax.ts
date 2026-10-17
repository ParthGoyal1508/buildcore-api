import { BillTaxBasis, BillTaxBasisSource } from '@prisma/client';

/**
 * Which tax applies, and how that was decided (023 FR-015, FR-016, FR-016a, research §5).
 *
 * Pure — no Nest, no Prisma — because the decision is a reading of two registration numbers and
 * nothing else, and because getting it wrong is an eighteen per cent error on a document somebody
 * pays.
 *
 * ## The derivation
 *
 * An Indian goods-and-services registration number begins with the two-digit code of the state that
 * issued it. Both parties in the client's own package begin `08`, which is Rajasthan, so the two
 * half-rate taxes apply and the full-rate row is blank. Different codes mean one party is out of
 * state, and the single full-rate tax applies instead.
 *
 * **Never both and never neither** (FR-015). Those are the two failures this exists to prevent, and
 * they fail in opposite directions: both is a bill 18% too high, neither is a bill 18% too low and
 * a liability the company carries itself.
 *
 * ## Why the derivation is reported and not just performed
 *
 * `Client` carries no `state` column today, so for a bill issued to a client the state has to be
 * read out of the registration number — and where that is absent too, the project's own flag is all
 * there is. That fallback is the **likely** path on the client direction rather than the exceptional
 * one, which is why FR-016a requires it be reported: a tax decision recorded on a row and shown to
 * nobody is a tax decision nobody made.
 */
export interface TaxBasisDecision {
  basis: BillTaxBasis;
  source: BillTaxBasisSource;
  /** The two state codes, where they could be read. Reported so a reviewer can check the reading. */
  issuerStateCode: string | null;
  receiverStateCode: string | null;
  /**
   * Set when the two state codes say the opposite of the basis charged (036 I5) — additive, and
   * never a refusal. See `taxBasisWarning`.
   */
  warning: string | null;
}

export interface TaxBasisInput {
  issuerGstin?: string | null;
  receiverGstin?: string | null;
  /**
   * The project's choice: true for CGST + SGST, false for IGST. It decides the basis.
   */
  projectCgstApplicable: boolean;
}

/**
 * The first two characters, where they are the two digits a state code is.
 *
 * Deliberately strict about the shape rather than lenient: a registration number that does not start
 * with two digits is not one this can read, and guessing from it would produce a confident answer
 * about somebody's tax.
 */
export function stateCodeOf(gstin?: string | null): string | null {
  if (!gstin) return null;
  const head = gstin.trim().slice(0, 2);
  return /^\d{2}$/.test(head) ? head : null;
}

/**
 * **The project decides** (2026-10-14).
 *
 * This used to derive the basis from the two parties' GSTINs and fall back to the project only where
 * one was missing. The company holds more than one registration, so its own GSTIN is not one fixed
 * state, and comparing it against the other party's answered a question nobody had asked. The
 * project now carries an explicit choice — CGST + SGST or IGST — and every bill on it, to the client
 * and from each subcontractor, follows that choice.
 *
 * The state codes are still read and reported, so a reviewer can see both parties' registrations
 * beside the tax that was charged.
 */
export function decideTaxBasis(input: TaxBasisInput): TaxBasisDecision {
  const basis = input.projectCgstApplicable
    ? BillTaxBasis.intra_state
    : BillTaxBasis.inter_state;
  return {
    basis,
    source: BillTaxBasisSource.from_project_flag,
    issuerStateCode: stateCodeOf(input.issuerGstin),
    receiverStateCode: stateCodeOf(input.receiverGstin),
    warning: taxBasisWarning({
      basis,
      issuerGstin: input.issuerGstin,
      receiverGstin: input.receiverGstin,
    }),
  };
}

/**
 * A sentence when the parties' registrations point the other way from the tax charged (036 I5).
 *
 * The project decides the basis (above) and that stays true: the company holds several
 * registrations, so a mismatch is sometimes right. But "both registered in 08 and charged IGST" is
 * also exactly what a wrong project setting looks like, and it is an eighteen per cent error on a
 * document somebody pays. So it is **said**, beside the figures, and never refused — the reviewer
 * is the one who knows which registration the bill goes out under.
 *
 * Null when either code cannot be read: an absent registration is reported as a missing header
 * field already, and a guess here would be a confident answer about somebody's tax.
 */
export function taxBasisWarning(input: {
  basis: BillTaxBasis;
  issuerGstin?: string | null;
  receiverGstin?: string | null;
}): string | null {
  const issuer = stateCodeOf(input.issuerGstin);
  const receiver = stateCodeOf(input.receiverGstin);
  if (!issuer || !receiver) return null;

  const sameState = issuer === receiver;
  const chargedIntra = input.basis === BillTaxBasis.intra_state;
  if (sameState === chargedIntra) return null;

  return sameState
    ? `Both parties are registered in state ${issuer}, which usually means CGST + SGST, but ` +
        'this bill charges IGST. Check the project’s tax setting before issuing it.'
    : `The parties are registered in different states (${issuer} and ${receiver}), which ` +
        'usually means IGST, but this bill charges CGST + SGST. Check the project’s tax setting ' +
        'before issuing it.';
}
