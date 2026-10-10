/**
 * Makes sure a company has the chain an action is submitted to.
 *
 * **Created and deliberately never removed.** A chain is company *configuration*, not test data:
 * production gets one at company creation from `DEFAULT_COMPANY_CHAINS`, and `npm run seed:chains`
 * installs any added afterwards. A suite that created and then deleted one left the shared seeded
 * company unable to approve the subject afterwards — which is how four tests in
 * `bill-package.e2e-spec.ts` began failing only when run alongside `dwr.e2e-spec.ts`, and passed
 * in isolation. Leaving it is what the company would really have.
 *
 * Idempotent, matching the seeder it stands in for: an existing chain is used as it is, because
 * overwriting a real one would point a company's approvals at levels this suite invented.
 */
export async function ensureApprovalChain(
  // The `sys` proxy each suite builds — a super-admin Prisma surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sys: any,
  companyId: string,
  actionType: string,
): Promise<string> {
  const existing = await sys.approvalChain.findFirst({
    where: { companyId, actionType },
    select: { id: true },
  });
  if (existing) return existing.id as string;

  // `ApprovalChain` carries no unique index on `(companyId, actionType)`, so two suites running
  // in parallel can both find nothing and both create one — leaving the company with a duplicate
  // chain and `findActiveChain` picking whichever it happens to read first. Re-checked after the
  // write, and the loser drops its own: the race is narrow but it is real, and it produced one
  // unexplained failure in a seven-suite run before this guard existed.
  const chain = await sys.approvalChain.create({
    data: { companyId, actionType, isActive: true },
    select: { id: true },
  });
  const all = await sys.approvalChain.findMany({
    where: { companyId, actionType },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  if (all.length > 1 && all[0].id !== chain.id) {
    await sys.approvalChain
      .deleteMany({ where: { id: chain.id } })
      .catch(() => undefined);
    return all[0].id as string;
  }
  // One Director level, the shape `DEFAULT_DIRECTOR_FINAL_LEVELS` carries for every subject that
  // ends with the final authority.
  await sys.approvalLevel.create({
    data: {
      companyId,
      chainId: chain.id,
      position: 1,
      slotKey: 'final',
      label: 'Director',
      isFinalAuthority: true,
    },
  });
  return chain.id as string;
}
