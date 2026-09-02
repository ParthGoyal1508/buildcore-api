import { deriveStatus } from './bocw.service';

describe('deriveStatus (FR-008)', () => {
  it('is pending when nothing has been paid', () => {
    expect(deriveStatus(1000, 0)).toBe('pending');
  });

  it('is partial when some but not all has been paid', () => {
    expect(deriveStatus(400, 600)).toBe('partial');
  });

  it('is paid when the balance is cleared', () => {
    expect(deriveStatus(0, 1000)).toBe('paid');
  });

  it('is paid when more than the liability has been paid', () => {
    // An overpayment clears the obligation. Reporting it as `partial` because the
    // balance is not exactly zero would leave a project flagged as owing money it
    // has already overpaid.
    expect(deriveStatus(-250, 1250)).toBe('paid');
  });

  it('is pending, not partial, for a zero liability with no payment', () => {
    expect(deriveStatus(0, 0)).toBe('paid');
  });
});
