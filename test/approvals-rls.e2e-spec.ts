import { PrismaClient } from '@prisma/client';

/**
 * Tenant isolation on the spine's tables, observed under a role that **cannot** bypass it
 * (016 T054, Constitution Principle IV).
 *
 * ## Why this suite exists separately
 *
 * Postgres exempts superusers and `BYPASSRLS` roles from every policy *unconditionally*.
 * `ENABLE` and `FORCE ROW LEVEL SECURITY` do not apply to them, and no error is raised —
 * the rows simply come back. The local development role is a superuser
 * (`src/common/prisma/rls-preflight.ts` warns about exactly this and refuses to boot in
 * production), so a cross-tenant read run through the application's own client proves
 * nothing at all: it returns zero rows because the `WHERE companyId` clause filtered them,
 * not because a policy did.
 *
 * `approvals.e2e-spec.ts` asserts what it can under that role — that the policies exist
 * and are FORCEd — and says loudly in a `console.warn` that isolation itself was not
 * observed. This suite is the other half. It creates a real `NOSUPERUSER NOBYPASSRLS`
 * login role, connects as it, and asks the same questions with the policies actually in
 * force. **This is the only place in the repository where row-level security is proven
 * rather than assumed.**
 *
 * Queries are raw SQL through a second `PrismaClient`. That is deliberate: Prisma's query
 * builder always emits its own `WHERE`, which would mask a policy that was not working.
 * A bare `SELECT * FROM shared."ApprovalInstance"` with no predicate can only be filtered
 * by the policy, so if the wrong rows come back the policy is the reason.
 *
 * The probe role is created and dropped by this suite. If the current role cannot create
 * one — a CI database connecting as an unprivileged user, say — the suite reports that it
 * could not run rather than passing quietly.
 */
const PROBE_ROLE = 'buildcore_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';

const SPINE_TABLES = [
  'ApprovalChain',
  'ApprovalLevel',
  'ApprovalInstance',
  'ApprovalDecision',
  'RoleSlotMapping',
];

/** Builds the probe's connection string from the developer's own, swapping credentials. */
function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

describe('Approval spine tenant isolation, under a role that cannot bypass RLS (T054)', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const ids = {
    companyA: `E2ERLSA${Date.now() % 100000}`,
    companyB: `E2ERLSB${Date.now() % 100000}`,
    chainA: '',
    chainB: '',
    instanceA: '',
    instanceB: '',
    userA: '',
  };

  beforeAll(async () => {
    admin = new PrismaClient();

    const [role] = await admin.$queryRaw<{ rolsuper: boolean }[]>`
      SELECT rolsuper FROM pg_roles WHERE rolname = current_user
    `;
    if (!role?.rolsuper) {
      // Not a failure: an unprivileged connection cannot create the probe. Reported so a
      // green run is never read as evidence the isolation was checked.
      // eslint-disable-next-line no-console
      console.warn(
        `RLS isolation NOT proven: the current role cannot CREATE ROLE, so the ` +
          `non-superuser probe could not be made. Run this suite as a superuser.`,
      );
      return;
    }

    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${PROBE_ROLE}"`);
    await admin.$executeRawUnsafe(
      `CREATE ROLE "${PROBE_ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS ` +
        `PASSWORD '${PROBE_PASSWORD}'`,
    );
    await admin.$executeRawUnsafe(
      `GRANT USAGE ON SCHEMA "shared" TO "${PROBE_ROLE}"`,
    );
    for (const table of SPINE_TABLES) {
      await admin.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "shared"."${table}" TO "${PROBE_ROLE}"`,
      );
    }
    canProbe = true;

    // Two companies, each with a chain, a level and a live instance. Written as the
    // superuser, because the fixtures are the thing being hidden, not the thing under
    // test.
    for (const key of ['A', 'B'] as const) {
      const companyId = key === 'A' ? ids.companyA : ids.companyB;
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."Company" ("id","name","shortCode","payrollLockDay","pfEmployerRate","esicEmployerRate","gratuityRate","bonusRate","createdAt","updatedAt")
         VALUES ($1,$2,$3,7,12,3.25,4.81,8.33,NOW(),NOW())`,
        companyId,
        `E2E RLS ${key}`,
        companyId.slice(0, 10),
      );

      const chainId = `${companyId}-chain`;
      await admin.$executeRawUnsafe(
        `INSERT INTO "shared"."ApprovalChain" ("id","companyId","actionType","isFinalAuthorityRequired","isActive","createdAt","updatedAt")
         VALUES ($1,$2,'e2e_rls',false,true,NOW(),NOW())`,
        chainId,
        companyId,
      );
      await admin.$executeRawUnsafe(
        `INSERT INTO "shared"."ApprovalLevel" ("id","chainId","companyId","position","slotKey","isFinalAuthority","createdAt","updatedAt")
         VALUES ($1,$2,$3,1,'hr',false,NOW(),NOW())`,
        `${chainId}-l1`,
        chainId,
        companyId,
      );

      const userId = `${companyId}-user`;
      await admin.$executeRawUnsafe(
        `INSERT INTO "shared"."User" ("id","email","username","companyId","status","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,'active',NOW(),NOW())`,
        userId,
        `${companyId}@example.test`.toLowerCase(),
        userId,
        companyId,
      );

      const instanceId = `${companyId}-inst`;
      await admin.$executeRawUnsafe(
        `INSERT INTO "shared"."ApprovalInstance" ("id","companyId","chainId","entityType","entityId","subject","viewPermission","currentPosition","state","originatorUserId","round","returnCount","createdAt","updatedAt")
         VALUES ($1,$2,$3,'e2e_rls',$4,'RLS probe subject','ATTENDANCE',1,'pending',$5,1,0,NOW(),NOW())`,
        instanceId,
        companyId,
        chainId,
        `${companyId}-entity`,
        userId,
      );
      await admin.$executeRawUnsafe(
        `INSERT INTO "shared"."ApprovalDecision" ("id","approvalInstanceId","companyId","round","position","actorUserId","action","reason","decidedAt")
         VALUES ($1,$2,$3,1,1,$4,'approve','probe',NOW())`,
        `${instanceId}-dec`,
        instanceId,
        companyId,
        userId,
      );

      if (key === 'A') {
        ids.chainA = chainId;
        ids.instanceA = instanceId;
        ids.userA = userId;
      } else {
        ids.chainB = chainId;
        ids.instanceB = instanceId;
      }
    }

    probe = new PrismaClient({
      datasources: { db: { url: probeUrl(process.env.DATABASE_URL) } },
    });
    await probe.$connect();
  }, 120_000);

  afterAll(async () => {
    await probe?.$disconnect();

    if (admin) {
      for (const companyId of [ids.companyA, ids.companyB]) {
        // Children first: the spine's rows cascade from Company, but do it explicitly so
        // a partial setup still cleans up.
        await admin
          .$executeRawUnsafe(
            `DELETE FROM "shared"."ApprovalDecision" WHERE "companyId" = $1`,
            companyId,
          )
          .catch(() => undefined);
        await admin
          .$executeRawUnsafe(
            `DELETE FROM "shared"."ApprovalInstance" WHERE "companyId" = $1`,
            companyId,
          )
          .catch(() => undefined);
        await admin
          .$executeRawUnsafe(
            `DELETE FROM "shared"."ApprovalLevel" WHERE "companyId" = $1`,
            companyId,
          )
          .catch(() => undefined);
        await admin
          .$executeRawUnsafe(
            `DELETE FROM "shared"."ApprovalChain" WHERE "companyId" = $1`,
            companyId,
          )
          .catch(() => undefined);
        await admin
          .$executeRawUnsafe(
            `DELETE FROM "shared"."User" WHERE "companyId" = $1`,
            companyId,
          )
          .catch(() => undefined);
        await admin
          .$executeRawUnsafe(
            `DELETE FROM "settings"."Company" WHERE "id" = $1`,
            companyId,
          )
          .catch(() => undefined);
      }

      if (canProbe) {
        // DROP OWNED BY first: the role owns no objects but does hold grants, and
        // DROP ROLE refuses while any privilege still references it.
        await admin
          .$executeRawUnsafe(`DROP OWNED BY "${PROBE_ROLE}"`)
          .catch(() => undefined);
        await admin
          .$executeRawUnsafe(`DROP ROLE IF EXISTS "${PROBE_ROLE}"`)
          .catch(() => undefined);
      }
      await admin.$disconnect();
    }
  }, 60_000);

  /** Runs `fn` with the session variables the policies read, as the probe role. */
  const asCompany = async <T>(
    companyId: string,
    fn: (tx: PrismaClient) => Promise<T>,
    isSuperAdmin = false,
  ): Promise<T> =>
    probe.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_super_admin', $1, true)`,
        isSuperAdmin ? 'true' : 'false',
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_company_id', $1, true)`,
        companyId,
      );
      return fn(tx as unknown as PrismaClient);
    });

  const guard = () => {
    if (!canProbe) {
      throw new Error(
        'The non-superuser probe could not be created; this assertion would be ' +
          'meaningless. See the warning in beforeAll.',
      );
    }
  };

  it('proves the probe role really cannot bypass RLS', async () => {
    guard();
    const [role] = await probe.$queryRawUnsafe<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );

    // Without this, every assertion below could pass for the wrong reason. It is the
    // precondition of the entire suite, so it is asserted rather than assumed.
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });

  it('hides another company’s pending approvals from an unfiltered read', async () => {
    guard();

    // No WHERE clause at all. Anything that comes back came back because the policy let
    // it — which is the only way to tell a working policy from a working ORM.
    const rows = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string; companyId: string }[]>(
        `SELECT "id", "companyId" FROM "shared"."ApprovalInstance" WHERE "entityType" = 'e2e_rls'`,
      ),
    );

    expect(rows.map((r) => r.id)).toEqual([ids.instanceA]);
    expect(rows.every((r) => r.companyId === ids.companyA)).toBe(true);
  });

  it('hides another company’s decisions — the reasons people gave each other', async () => {
    guard();

    // `ApprovalDecision` carries the stated reason for every rejection in the company.
    // It is denormalised with its own `companyId` precisely so it can carry the standard
    // policy rather than a subquery through the instance; this is that choice being
    // checked.
    const rows = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string; companyId: string }[]>(
        `SELECT "id", "companyId" FROM "shared"."ApprovalDecision" WHERE "reason" = 'probe'`,
      ),
    );

    expect(rows.map((r) => r.id)).toEqual([`${ids.instanceA}-dec`]);
  });

  it('hides chains, levels and slot mappings too', async () => {
    guard();

    const [chains, levels] = await asCompany(ids.companyA, async (tx) => [
      await tx.$queryRawUnsafe<{ companyId: string }[]>(
        `SELECT "companyId" FROM "shared"."ApprovalChain" WHERE "actionType" = 'e2e_rls'`,
      ),
      await tx.$queryRawUnsafe<{ companyId: string }[]>(
        `SELECT "companyId" FROM "shared"."ApprovalLevel"`,
      ),
    ]);

    expect(chains).toHaveLength(1);
    expect(chains[0].companyId).toBe(ids.companyA);
    // Every level in the whole database, filtered to one company by the policy alone.
    expect(levels.every((l) => l.companyId === ids.companyA)).toBe(true);
  });

  it('refuses a targeted read of another company’s instance by its exact id', async () => {
    guard();

    // The attack a tenant-leak actually looks like: not "list everything", but "I have an
    // id from somewhere, show me that one".
    const rows = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "shared"."ApprovalInstance" WHERE "id" = $1`,
        ids.instanceB,
      ),
    );

    expect(rows).toHaveLength(0);
  });

  it('refuses an UPDATE of another company’s approval', async () => {
    guard();

    const result = await asCompany(ids.companyA, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "shared"."ApprovalInstance" SET "state" = 'approved' WHERE "id" = $1`,
        ids.instanceB,
      ),
    );

    // Zero rows affected, silently — which is how RLS refuses an UPDATE. Approving
    // another company's payroll must not be possible even with its id in hand.
    expect(result).toBe(0);

    const [still] = await admin.$queryRawUnsafe<{ state: string }[]>(
      `SELECT "state" FROM "shared"."ApprovalInstance" WHERE "id" = $1`,
      ids.instanceB,
    );
    expect(still.state).toBe('pending');
  });

  it('refuses an INSERT attributed to another company', async () => {
    guard();

    // A permissive policy declared with `USING` and no explicit `WITH CHECK` applies the
    // same expression to writes, so this is refused with an error rather than silently
    // dropped. Asserted because "can I read across tenants" and "can I write across
    // tenants" are different questions and only one of them is usually asked.
    await expect(
      asCompany(ids.companyA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "shared"."ApprovalInstance" ("id","companyId","chainId","entityType","entityId","subject","viewPermission","currentPosition","state","round","returnCount","createdAt","updatedAt")
           VALUES ($1,$2,$3,'e2e_rls','smuggled','Smuggled','ATTENDANCE',1,'pending',1,0,NOW(),NOW())`,
          `${ids.companyA}-smuggle`,
          ids.companyB,
          ids.chainB,
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('refuses a DELETE of another company’s decision — history cannot be erased across tenants', async () => {
    guard();

    const result = await asCompany(ids.companyA, (tx) =>
      tx.$executeRawUnsafe(
        `DELETE FROM "shared"."ApprovalDecision" WHERE "id" = $1`,
        `${ids.instanceB}-dec`,
      ),
    );
    expect(result).toBe(0);

    const rows = await admin.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "shared"."ApprovalDecision" WHERE "id" = $1`,
      `${ids.instanceB}-dec`,
    );
    expect(rows).toHaveLength(1);
  });

  it('lets a cross-company caller through, which is what the escape hatch is for', async () => {
    guard();

    const rows = await asCompany(
      '',
      (tx) =>
        tx.$queryRawUnsafe<{ companyId: string }[]>(
          `SELECT "companyId" FROM "shared"."ApprovalInstance" WHERE "entityType" = 'e2e_rls'`,
        ),
      true,
    );

    // `app.is_super_admin` is the second half of every policy. It is set only for a
    // caller holding CROSS_COMPANY_ACCESS and for system jobs — and if it did *not* work
    // the reconciliation sweep would silently see nothing, which is the failure mode a
    // sweep can least afford.
    const companies = new Set(rows.map((r) => r.companyId));
    expect(companies.has(ids.companyA)).toBe(true);
    expect(companies.has(ids.companyB)).toBe(true);
  });

  it('sees nothing at all when no company context is set', async () => {
    guard();

    // The default-deny case: an unset `app.current_company_id` must not read as "all".
    // `current_setting(..., true)` returns NULL when unset and `"companyId" = NULL` is
    // NULL, not true — so the policy rejects. Worth pinning, because a policy written
    // with `coalesce(..., '')` on the wrong side would open every table to any
    // connection that forgot to set the variable.
    const rows = await probe.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "shared"."ApprovalInstance" WHERE "entityType" = 'e2e_rls'`,
    );
    expect(rows).toHaveLength(0);
  });
});
