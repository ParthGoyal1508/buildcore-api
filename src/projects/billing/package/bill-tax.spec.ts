import { BillTaxBasis, BillTaxBasisSource } from '@prisma/client';

import { decideTaxBasis, stateCodeOf, taxBasisWarning } from './bill-tax';

/**
 * Which tax applies, and how it was decided (023 FR-015, FR-016, FR-016a — task T035).
 *
 * Both parties on the client's real RA-12 carry registration numbers beginning `08`, which is
 * Rajasthan — so the half-rate pair applies and the full-rate row is blank. That is the case the
 * document settles; the ones below it are the cases the document does not contain, which is exactly
 * why they need writing by hand.
 */
describe('deciding the tax basis', () => {
  it('charges CGST + SGST where the project says so, whatever the two numbers read', () => {
    // 2026-10-14. The company holds more than one GSTIN, so the numbers cannot settle it — the
    // project's choice does. Here the numbers are in different states and the project wins.
    expect(
      decideTaxBasis({
        issuerGstin: '08AABCH1234D1ZX',
        receiverGstin: '27AAMCP8659H1Z2',
        projectCgstApplicable: true,
      }),
    ).toMatchObject({
      basis: BillTaxBasis.intra_state,
      source: BillTaxBasisSource.from_project_flag,
      issuerStateCode: '08',
      receiverStateCode: '27',
    });
  });

  it('charges IGST where the project says so, even with both numbers in one state', () => {
    expect(
      decideTaxBasis({
        issuerGstin: '08AABCH1234D1ZX',
        receiverGstin: '08AAMCP8659H1Z2',
        projectCgstApplicable: false,
      }),
    ).toMatchObject({
      basis: BillTaxBasis.inter_state,
      source: BillTaxBasisSource.from_project_flag,
    });
  });

  it('reports the state codes it could read, beside the project’s choice', () => {
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

describe('warning when the registrations point the other way (036 I5)', () => {
  // Never a refusal: the project decides, and the company holds several registrations. But "both
  // in 08, charged IGST" is also exactly what a wrong project setting looks like.
  it('warns on IGST between two parties registered in one state', () => {
    const decision = decideTaxBasis({
      issuerGstin: '08AABCH1234D1ZX',
      receiverGstin: '08AAMCP8659H1Z2',
      projectCgstApplicable: false,
    });
    expect(decision.basis).toBe(BillTaxBasis.inter_state);
    expect(decision.warning).toMatch(/registered in state 08.*charges IGST/);
  });

  it('warns on CGST + SGST between parties in different states', () => {
    expect(
      decideTaxBasis({
        issuerGstin: '08AABCH1234D1ZX',
        receiverGstin: '27AAMCP8659H1Z2',
        projectCgstApplicable: true,
      }).warning,
    ).toMatch(/different states \(08 and 27\).*CGST \+ SGST/);
  });

  it('is silent when the codes agree with the basis', () => {
    expect(
      taxBasisWarning({
        basis: BillTaxBasis.intra_state,
        issuerGstin: '08AABCH1234D1ZX',
        receiverGstin: '08AAMCP8659H1Z2',
      }),
    ).toBeNull();
  });

  it('is silent when a code cannot be read, rather than guessing', () => {
    expect(
      taxBasisWarning({
        basis: BillTaxBasis.inter_state,
        issuerGstin: '08AABCH1234D1ZX',
        receiverGstin: null,
      }),
    ).toBeNull();
  });
});
