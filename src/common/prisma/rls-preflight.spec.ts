import { assertRlsEnforceable } from './rls-preflight';

const prismaReturning = (rows: unknown) =>
  ({ $queryRaw: jest.fn().mockResolvedValue(rows) } as never);

describe('assertRlsEnforceable', () => {
  it('passes for a role that enforces RLS', async () => {
    await expect(
      assertRlsEnforceable(
        prismaReturning([{ rolsuper: false, rolbypassrls: false }]),
        true,
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['a superuser', { rolsuper: true, rolbypassrls: false }],
    ['a BYPASSRLS role', { rolsuper: false, rolbypassrls: true }],
  ])('refuses to boot in production as %s', async (_label, role) => {
    await expect(
      assertRlsEnforceable(prismaReturning([role]), true),
    ).rejects.toThrow(/tenant isolation is NOT in effect/);
  });

  it.each([
    ['a superuser', { rolsuper: true, rolbypassrls: false }],
    ['a BYPASSRLS role', { rolsuper: false, rolbypassrls: true }],
  ])('warns but still boots outside production as %s', async (_label, role) => {
    await expect(
      assertRlsEnforceable(prismaReturning([role]), false),
    ).resolves.toBeUndefined();
  });

  it('does not take down a deployment when the check itself fails', async () => {
    // An inconclusive result is not proof of a problem — a missing catalog grant
    // must not be able to stop a healthy production boot.
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('permission denied')),
    } as never;
    await expect(assertRlsEnforceable(prisma, true)).resolves.toBeUndefined();
  });

  it('does not throw when the role cannot be resolved', async () => {
    await expect(
      assertRlsEnforceable(prismaReturning([]), true),
    ).resolves.toBeUndefined();
  });
});
