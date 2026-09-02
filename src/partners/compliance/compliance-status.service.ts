import { Injectable } from '@nestjs/common';
import {
  ContractorComplianceStatus,
  MonthlyComplianceStatus,
  Prisma,
} from '@prisma/client';

/** `YYYY-MM` of the most recently *concluded* calendar month. */
export function lastCompletedMonth(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed, so this is already last month's index
  const date = new Date(Date.UTC(year, month - 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    '0',
  )}`;
}

/**
 * Derives a monthly record's own status from which challans are present (FR-006).
 *
 * `verified` is never produced here — it is a human assertion made through the verify
 * endpoint, not something that follows from the data.
 */
export function deriveMonthlyStatus(input: {
  pfChallanNumber?: string | null;
  esicChallanNumber?: string | null;
}): MonthlyComplianceStatus {
  const hasPf = Boolean(input.pfChallanNumber?.trim());
  const hasEsic = Boolean(input.esicChallanNumber?.trim());
  if (hasPf && hasEsic) return MonthlyComplianceStatus.submitted;
  if (hasPf || hasEsic) return MonthlyComplianceStatus.partial;
  return MonthlyComplianceStatus.missing;
}

/**
 * Keeps `ContractorProfile.complianceStatus` in step with the filings (FR-005).
 *
 * Judged on the most recently concluded month alone, not on the whole history. A
 * contractor who filed for two years and then stopped is not compliant today, and an
 * all-time average would say otherwise for a long time.
 *
 * The month's own status already encodes what the master PRD's rule needs — both
 * challans present is `submitted`, exactly one is `partial` — so the mapping below is
 * that rule, not a second derivation of it.
 */
@Injectable()
export class ComplianceStatusService {
  /**
   * Recomputes and persists, inside the caller's transaction.
   *
   * Taking the transaction client rather than opening its own is what makes a
   * compliance write and the status it implies atomic: a committed filing with a
   * stale contractor status would show a contractor as non-compliant on a list while
   * their record says otherwise.
   */
  async recompute(
    tx: Prisma.TransactionClient,
    contractorProfileId: string,
    now: Date = new Date(),
  ): Promise<ContractorComplianceStatus> {
    const month = lastCompletedMonth(now);
    const record = await tx.monthlyCompliance.findUnique({
      where: { contractorProfileId_month: { contractorProfileId, month } },
      select: { status: true },
    });

    let status: ContractorComplianceStatus;
    if (!record) {
      status = ContractorComplianceStatus.non_compliant;
    } else if (
      record.status === MonthlyComplianceStatus.submitted ||
      record.status === MonthlyComplianceStatus.verified
    ) {
      status = ContractorComplianceStatus.compliant;
    } else if (record.status === MonthlyComplianceStatus.partial) {
      status = ContractorComplianceStatus.partially_compliant;
    } else {
      status = ContractorComplianceStatus.non_compliant;
    }

    await tx.contractorProfile.update({
      where: { id: contractorProfileId },
      data: { complianceStatus: status },
    });
    return status;
  }
}
