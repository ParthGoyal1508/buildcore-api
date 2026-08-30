/**
 * Test double for the RLS-aware Prisma access every settings service uses.
 *
 * `withRlsContext()` wraps its work in `prisma.$transaction()` after two
 * `set_config` calls, so a mock only has to run the callback against a stand-in
 * transaction client for the services under test to behave normally.
 */
export interface PrismaMock {
  $transaction: jest.Mock;
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
  [delegate: string]: unknown;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function createPrismaMock(delegates: Record<string, any> = {}) {
  const tx: Record<string, any> = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...delegates,
  };

  const prisma = {
    ...tx,
    $transaction: jest.fn(
      (fn: (client: unknown) => unknown) =>
        // Mirrors the real client: hand the callback a transaction-scoped client.
        Promise.resolve(fn(tx)) as Promise<unknown>,
    ),
  } as unknown as PrismaMock & { tx: Record<string, any> };

  prisma.tx = tx;
  return prisma;
}

/** An authenticated caller with no cross-company access, scoped to one company. */
export const callerFor = (
  companyId: string | null,
  extra: Record<string, unknown> = {},
) =>
  ({
    id: 'caller-1',
    companyId,
    permissions: [],
    roleNames: [],
    ...extra,
  } as never);
