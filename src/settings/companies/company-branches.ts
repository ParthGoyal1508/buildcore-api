import { BadRequestException } from '@nestjs/common';
import type { Company, CompanyBranch, Prisma } from '@prisma/client';
import { canonicalStateName, gstStateCodeFor } from '../../common/gst-states';

/**
 * Row-level helpers for `settings.CompanyBranch` (041), shared by `CompanyBranchesService` (the
 * management surface) and `CompaniesService` (the identity every document prints). Plain functions
 * over a transaction so company create/update can call them inside their own transaction.
 */

/** The fields a branch and its company both carry; the company's copy mirrors the head office. */
export const MIRRORED_FIELDS = [
  'gstin',
  'address',
  'city',
  'state',
  'pinCode',
  'phone',
  'email',
  'website',
  'pfEstablishmentCode',
  'esicCode',
  'professionalTaxRegNumber',
] as const;
export type MirroredField = (typeof MIRRORED_FIELDS)[number];
export type MirroredValues = Partial<Record<MirroredField, string | null>>;

/** Just the mirrored fields present on `source` — `undefined` means "not mentioned". */
export function pickMirrored(source: object): MirroredValues {
  const out: MirroredValues = {};
  for (const field of MIRRORED_FIELDS) {
    const value = (source as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = (value as string | null) ?? null;
  }
  return out;
}

/** "Godhra (Gujarat)" — what a picker shows for a branch with no label of its own. */
export function branchLabel(
  b: Pick<CompanyBranch, 'label' | 'city' | 'state'>,
): string {
  if (b.label?.trim()) return b.label.trim();
  const where = [b.city, b.state && `(${b.state})`].filter(Boolean).join(' ');
  return where || 'Head office';
}

/** "28 A Gandhi Nagar, Deoli, Rajasthan - 304804" — the one-line address a document prints. */
export function composeAddress(
  b: Pick<CompanyBranch, 'address' | 'city' | 'state' | 'pinCode'>,
): { address: string | null; place: string | null } {
  const place = [b.city, b.state].filter(Boolean).join(', ');
  const address =
    [
      b.address,
      place && b.pinCode ? `${place} - ${b.pinCode}` : place || b.pinCode,
    ]
      .filter(Boolean)
      .join(', ') || null;
  return { address, place: place || null };
}

/**
 * The two checks a GSTIN gets beyond its format (research R9), each with its own message:
 * its first two characters must be the GST code of the branch's state, and characters 3–12 must be
 * the company's PAN when one is recorded.
 */
export function assertGstinFits(
  gstin: string | null | undefined,
  state: string | null | undefined,
  companyPan: string | null | undefined,
): void {
  if (!gstin) return;
  const code = gstin.slice(0, 2);
  const stateCode = gstStateCodeFor(state);
  if (!stateCode) {
    throw new BadRequestException(
      `Choose the branch's state so GSTIN ${gstin} can be checked against it.`,
    );
  }
  if (code !== stateCode) {
    throw new BadRequestException(
      `GSTIN state code ${code} does not match the branch state (${canonicalStateName(
        state,
      )}, ${stateCode}).`,
    );
  }
  if (companyPan && gstin.slice(2, 12) !== companyPan.toUpperCase()) {
    throw new BadRequestException(
      `GSTIN ${gstin} does not belong to this company's PAN ${companyPan.toUpperCase()}.`,
    );
  }
}

/** The head-office row, or null for a company that somehow has none yet. */
export function findHeadOffice(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<CompanyBranch | null> {
  return tx.companyBranch.findFirst({
    where: { companyId, isHeadOffice: true },
  });
}

/**
 * Makes sure the company has its head office, created from the company's own columns when it does
 * not — the same backfill `20261022100000_company_branches` ran. Idempotent.
 */
export async function ensureHeadOffice(
  tx: Prisma.TransactionClient,
  companyId: string,
  /** The company row, when the caller already holds it (a create). */
  known?: Pick<Company, MirroredField>,
): Promise<CompanyBranch> {
  const existing = await findHeadOffice(tx, companyId);
  if (existing) return existing;
  const company =
    known ?? (await tx.company.findUniqueOrThrow({ where: { id: companyId } }));
  return tx.companyBranch.create({
    data: {
      companyId,
      ...Object.fromEntries(
        MIRRORED_FIELDS.map((f) => [f, company[f] || null]),
      ),
      isHeadOffice: true,
      isActive: true,
    },
  });
}

/**
 * Copies the head office onto the company's own columns (research R2), so anything that still
 * reads `Company.gstin` / `address` / codes prints the head office — today's output.
 */
export async function mirrorHeadOffice(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<void> {
  const head = await findHeadOffice(tx, companyId);
  if (!head) return;
  await tx.company.update({
    where: { id: companyId },
    data: Object.fromEntries(MIRRORED_FIELDS.map((f) => [f, head[f]])),
  });
}
