import {
  ContractorComplianceStatus,
  MonthlyComplianceStatus,
} from '@prisma/client';

import {
  ComplianceStatusService,
  deriveMonthlyStatus,
  lastCompletedMonth,
} from './compliance-status.service';

describe('deriveMonthlyStatus (FR-006)', () => {
  it('is submitted when both challans are present', () => {
    expect(
      deriveMonthlyStatus({
        pfChallanNumber: 'PF-1',
        esicChallanNumber: 'E-1',
      }),
    ).toBe(MonthlyComplianceStatus.submitted);
  });

  it('is partial when only PF is present', () => {
    expect(
      deriveMonthlyStatus({ pfChallanNumber: 'PF-1', esicChallanNumber: null }),
    ).toBe(MonthlyComplianceStatus.partial);
  });

  it('is partial when only ESIC is present', () => {
    expect(
      deriveMonthlyStatus({ pfChallanNumber: null, esicChallanNumber: 'E-1' }),
    ).toBe(MonthlyComplianceStatus.partial);
  });

  it('is missing when neither is present', () => {
    expect(
      deriveMonthlyStatus({ pfChallanNumber: null, esicChallanNumber: null }),
    ).toBe(MonthlyComplianceStatus.missing);
  });

  it('treats a whitespace-only challan number as absent', () => {
    // A form that submits an empty text input sends "" or " ", and counting that as
    // a filing would report a contractor as compliant on the strength of a stray
    // keystroke.
    expect(
      deriveMonthlyStatus({ pfChallanNumber: '   ', esicChallanNumber: null }),
    ).toBe(MonthlyComplianceStatus.missing);
  });
});

describe('lastCompletedMonth', () => {
  it('is the previous calendar month', () => {
    expect(lastCompletedMonth(new Date('2026-09-03T00:00:00Z'))).toBe(
      '2026-08',
    );
  });

  it('rolls back across a year boundary', () => {
    expect(lastCompletedMonth(new Date('2026-01-15T00:00:00Z'))).toBe(
      '2025-12',
    );
  });

  it('is unaffected by the day of month', () => {
    expect(lastCompletedMonth(new Date('2026-09-01T00:00:00Z'))).toBe(
      '2026-08',
    );
    expect(lastCompletedMonth(new Date('2026-09-30T23:59:00Z'))).toBe(
      '2026-08',
    );
  });
});

describe('ComplianceStatusService.recompute (FR-005)', () => {
  const now = new Date('2026-09-03T00:00:00Z'); // last completed month: 2026-08

  function txWith(status: MonthlyComplianceStatus | null) {
    return {
      monthlyCompliance: {
        findUnique: jest
          .fn()
          .mockResolvedValue(status === null ? null : { status }),
      },
      contractorProfile: { update: jest.fn().mockResolvedValue({}) },
    };
  }

  it.each([
    [MonthlyComplianceStatus.submitted, ContractorComplianceStatus.compliant],
    [MonthlyComplianceStatus.verified, ContractorComplianceStatus.compliant],
    [
      MonthlyComplianceStatus.partial,
      ContractorComplianceStatus.partially_compliant,
    ],
    [MonthlyComplianceStatus.missing, ContractorComplianceStatus.non_compliant],
  ])('maps a %s month to %s', async (monthStatus, expected) => {
    const service = new ComplianceStatusService();
    const tx = txWith(monthStatus);
    await expect(
      service.recompute(tx as never, 'contractor-1', now),
    ).resolves.toBe(expected);
    expect(tx.contractorProfile.update).toHaveBeenCalledWith({
      where: { id: 'contractor-1' },
      data: { complianceStatus: expected },
    });
  });

  it('is non_compliant when the month has no record at all', async () => {
    // Not "unknown" and not the previous value: a contractor who has filed nothing
    // for the concluded month has not demonstrated compliance, and carrying forward
    // last month's verdict would keep them green indefinitely.
    const service = new ComplianceStatusService();
    const tx = txWith(null);
    await expect(
      service.recompute(tx as never, 'contractor-1', now),
    ).resolves.toBe(ContractorComplianceStatus.non_compliant);
  });

  it('judges the last completed month, not the current one', async () => {
    const service = new ComplianceStatusService();
    const tx = txWith(MonthlyComplianceStatus.submitted);
    await service.recompute(tx as never, 'contractor-1', now);
    expect(tx.monthlyCompliance.findUnique).toHaveBeenCalledWith({
      where: {
        contractorProfileId_month: {
          contractorProfileId: 'contractor-1',
          month: '2026-08',
        },
      },
      select: { status: true },
    });
  });
});
