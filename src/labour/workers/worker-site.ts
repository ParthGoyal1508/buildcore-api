import { Prisma } from '@prisma/client';

/**
 * 052: the site a worker belonged to on `date`. A transfer takes effect on its `transferredOn`, so
 * the earliest transfer after the date names the site the worker was moved away from; with none,
 * the worker's current site. Used where a day has no punch to say which site it belongs to — a
 * correction adding a forgotten day from before a transfer lands at the site the worker was at.
 */
export async function siteOnDate(
  tx: Prisma.TransactionClient,
  worker: { id: string; siteId: string },
  date: Date,
): Promise<string> {
  const later = await tx.labourWorkerTransfer.findFirst({
    where: { workerId: worker.id, transferredOn: { gt: date } },
    orderBy: [{ transferredOn: 'asc' }, { createdAt: 'asc' }],
    select: { fromSiteId: true },
  });
  return later?.fromSiteId ?? worker.siteId;
}
