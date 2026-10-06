import { BillTaxBasis, BillTaxBasisSource } from '@prisma/client';

import { decideTaxBasis, stateCodeOf } from './bill-tax';

/**
 * Which tax applies, and how it was decided (023 FR-015, FR-016, FR-016a — task T035).
 *
 * Both parties on the client's real RA-12 carry registration numbers beginning `08`, which is
 * Rajasthan — so the half-rate pair applies and the full-rate row is blank. That is the case the
 * document settles; the ones below it are the cases the document does not contain, which is exactly
 * why they need writing by hand.
 */
describe('deciding the tax basis', () => {
  it('reads the same state from both numbers and applies the half-rate pair', () => {
    expect(
      decideTaxBasis({
        issuerGstin: '08AABCH1234D1ZX',
        receiverGstin: '08AAMCP8659H1Z2',
        projectCgstApplicable: false,
      }),
    ).toMatchObject({
      basis: BillTaxBasis.intra_state,
      source: BillTaxBasisSource.derived_from_gstin,
      issuerStateCode: '08',
      receiverStateCode: '08',
    });
  });

  it('applies the full-rate tax across states', () => {
    expect(
      decideTaxBasis({
        issuerGstin: '08AABCH1234D1ZX',
        receiverGstin: '27AAMCP8659H1Z2',
        projectCgstApplicable: true,
      }),
    ).toMatchObject({
      basis: BillTaxBasis.inter_state,
      source: BillTaxBasisSource.derived_from_gstin,
    });
  });

  it('derives from the numbers rather than from the project’s flag, where it can', () => {
    // FR-016. The flag is set once when a project is created and cannot know which subcontractor a
    // bill is going to — so where the registration numbers can answer, they do, and the flag's
    // disagreement is overruled rather than averaged.
    const decision = decideTaxBasis({
      issuerGstin: '08AABCH1234D1ZX',
      receiverGstin: '08AAMCP8659H1Z2',
      // Says inter-state. The numbers say otherwise.
      projectCgstApplicable: false,
    });

    expect(decision.basis).toBe(BillTaxBasis.intra_state);
    expect(decision.source).toBe(BillTaxBasisSource.derived_from_gstin);
  });

  it('falls back to the project’s flag and says that it did', () => {
    // FR-016a. `Client` carries no `state` column today, so on a bill issued to a client this is
    // the likely path rather than the exceptional one — and a fallback recorded on a row and shown
    // to nobody is a tax decision nobody made.
    const decision = decideTaxBasis({
      issuerGstin: '08AABCH1234D1ZX',
      receiverGstin: null,
      projectCgstApplicable: true,
    });

    expect(decision).toMatchObject({
      basis: BillTaxBasis.intra_state,
      source: BillTaxBasisSource.from_project_flag,
      issuerStateCode: '08',
      receiverStateCode: null,
    });
  });

  it('needs both numbers, not one', () => {
    // Knowing only our own state says nothing about whether the other party is in it. One-sided
    // knowledge reads as a derivation while being a guess, so it reports as the fallback it is.
    expect(
      decideTaxBasis({
        issuerGstin: null,
        receiverGstin: '08AAMCP8659H1Z2',
        projectCgstApplicable: false,
      }).source,
    ).toBe(BillTaxBasisSource.from_project_flag);
  });

  it('refuses to read a state out of a number that does not carry one', () => {
    // Strict about the shape rather than lenient: guessing from a malformed number would produce a
    // confident answer about somebody's tax.
    expect(stateCodeOf('INVALID')).toBeNull();
    expect(stateCodeOf('')).toBeNull();
    expect(stateCodeOf(null)).toBeNull();
    expect(stateCodeOf(' 08AABCH1234D1ZX ')).toBe('08');
  });

  it('never leaves the basis unset', () => {
    // FR-015's "never neither", at the only place it could happen: with nothing at all to go on.
    const decision = decideTaxBasis({
      issuerGstin: null,
      receiverGstin: null,
      projectCgstApplicable: false,
    });

    expect([BillTaxBasis.intra_state, BillTaxBasis.inter_state]).toContain(
      decision.basis,
    );
    expect(decision.source).toBe(BillTaxBasisSource.from_project_flag);
  });
});
