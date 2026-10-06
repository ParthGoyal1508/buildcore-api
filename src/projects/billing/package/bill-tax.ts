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
}

export interface TaxBasisInput {
  issuerGstin?: string | null;
  receiverGstin?: string | null;
  /**
   * The project's existing flag: true where the half-rate pair applies.
   *
   * The fallback, and only the fallback. A flag set once when the project was created cannot know
   * which subcontractor a bill is going to.
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

export function decideTaxBasis(input: TaxBasisInput): TaxBasisDecision {
  const issuerStateCode = stateCodeOf(input.issuerGstin);
  const receiverStateCode = stateCodeOf(input.receiverGstin);

  if (issuerStateCode && receiverStateCode) {
    return {
      basis:
        issuerStateCode === receiverStateCode
          ? BillTaxBasis.intra_state
          : BillTaxBasis.inter_state,
      source: BillTaxBasisSource.derived_from_gstin,
      issuerStateCode,
      receiverStateCode,
    };
  }

  // Both numbers are needed, not one: knowing only our own state says nothing about whether the
  // other party is in it. One-sided knowledge reads as a derivation while being a guess.
  return {
    basis: input.projectCgstApplicable
      ? BillTaxBasis.intra_state
      : BillTaxBasis.inter_state,
    source: BillTaxBasisSource.from_project_flag,
    issuerStateCode,
    receiverStateCode,
  };
}
