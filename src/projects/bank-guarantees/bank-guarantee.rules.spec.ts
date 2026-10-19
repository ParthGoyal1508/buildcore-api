import { BankGuaranteeStatus } from '@prisma/client';

import {
  daysToExpiry,
  displayStatus,
  guaranteeDateErrors,
  liveUntil,
} from './bank-guarantee.rules';

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('bank guarantee rules (037)', () => {
  describe('displayStatus', () => {
    const running = {
      status: BankGuaranteeStatus.RUNNING,
      claimPeriodEndDate: null,
    };

    it('is Running up to and including the expiry date', () => {
      expect(
        displayStatus(
          { ...running, expiryDate: d('2026-11-30') },
          '2026-11-30',
        ),
      ).toBe('RUNNING');
    });

    it('is Expired the day after, while still Running in the record', () => {
      expect(
        displayStatus(
          { ...running, expiryDate: d('2026-11-30') },
          '2026-12-01',
        ),
      ).toBe('EXPIRED');
    });

    it('runs to the claim period end when one is set', () => {
      const bg = {
        ...running,
        expiryDate: d('2026-11-30'),
        claimPeriodEndDate: d('2027-02-28'),
      };
      expect(displayStatus(bg, '2026-12-15')).toBe('RUNNING');
      expect(displayStatus(bg, '2027-03-01')).toBe('EXPIRED');
    });

    it('is Running with no dates (applied for, not issued)', () => {
      expect(
        displayStatus({ ...running, expiryDate: null }, '2030-01-01'),
      ).toBe('RUNNING');
    });

    it('shows Released and Encashed as stored, whatever the dates', () => {
      expect(
        displayStatus(
          {
            status: BankGuaranteeStatus.RELEASED,
            expiryDate: d('2020-01-01'),
            claimPeriodEndDate: null,
          },
          '2026-10-18',
        ),
      ).toBe('RELEASED');
      expect(
        displayStatus(
          {
            status: BankGuaranteeStatus.ENCASHED,
            expiryDate: d('2020-01-01'),
            claimPeriodEndDate: null,
          },
          '2026-10-18',
        ),
      ).toBe('ENCASHED');
    });
  });

  it('liveUntil prefers the claim period end', () => {
    expect(
      liveUntil({
        expiryDate: d('2026-11-30'),
        claimPeriodEndDate: d('2027-01-31'),
      }),
    ).toEqual(d('2027-01-31'));
    expect(
      liveUntil({ expiryDate: d('2026-11-30'), claimPeriodEndDate: null }),
    ).toEqual(d('2026-11-30'));
    expect(
      liveUntil({ expiryDate: null, claimPeriodEndDate: null }),
    ).toBeNull();
  });

  it('daysToExpiry counts calendar days, negative once past', () => {
    expect(
      daysToExpiry(
        { expiryDate: d('2026-11-17'), claimPeriodEndDate: null },
        '2026-10-18',
      ),
    ).toBe(30);
    expect(
      daysToExpiry(
        { expiryDate: d('2026-10-17'), claimPeriodEndDate: null },
        '2026-10-18',
      ),
    ).toBe(-1);
  });

  describe('guaranteeDateErrors', () => {
    it('allows a guarantee applied for, with no number and no dates', () => {
      expect(guaranteeDateErrors({})).toEqual([]);
    });

    it('needs issue and expiry dates once a number is entered', () => {
      expect(guaranteeDateErrors({ bgNumber: '0931IGP003835826' })).toEqual([
        'Issue date is required once the BG number is entered.',
        'Expiry date is required once the BG number is entered.',
      ]);
    });

    it('refuses expiry before issue, and a claim period ending before expiry', () => {
      expect(
        guaranteeDateErrors({
          issueDate: '2026-06-17',
          expiryDate: '2026-06-01',
        }),
      ).toEqual(['Expiry date cannot be before the issue date.']);
      expect(
        guaranteeDateErrors({
          issueDate: '2026-06-17',
          expiryDate: '2026-11-30',
          claimPeriodEndDate: '2026-11-01',
        }),
      ).toEqual(['Claim period end date cannot be before the expiry date.']);
    });
  });
});
