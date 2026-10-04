import { PrismaClient } from '@prisma/client';

/**
 * The company switcher's stored row, under a role that **cannot** bypass RLS (019 FR-008 to
 * FR-013).
 *
 * ## The defect this exists for
 *
 * On the deployment, switching company failed with *"Could not switch company. You are still
 * working in the previous one."* and this in the server log:
 *
 *     Invalid `prisma.userCompanySelection.upsert()` invocation:
 *     PostgresError { code: "42501", message: "new row violates row-level security policy
 *                     (USING expression) for table \\"UserCompanySelection\\"" }
 *
 * `select()` ran the upsert scoped to the company being switched **to**. The row is keyed by
 * user and the statement moves it between tenants, so Prisma's `INSERT ... ON CONFLICT DO
 * UPDATE` made Postgres apply the policy's USING to the row *already there* — which still held
 * the previous company. The first selection worked, because there was no row yet. Every switch
 * after it failed, so a user could choose a company once and was then stuck in it.
 *
 * ## Why nothing caught it
 *
 * Two things had to be true at once, and both were.
 *
 * 1. **The existing e2e suite only ever selects once.** `company-selection.e2e-spec.ts` goes
 *    from no selection to company B and never from B to A, so the conflict path was never
 *    taken.
 * 2. **The local and CI role is a superuser, and Postgres exempts superusers from RLS
 *    unconditionally.** Even a test that did switch twice would have passed here. Five
 *    `*-rls.e2e-spec.ts` suites already exist in this directory for exactly this reason —
 *    `documents-rls` says in as many words that it "is what made every pre-016 RLS test in
 *    this repository vacuous". `UserCompanySelection` was added later and never got one, so
 *    its policy had never been in force in any test run.
 *
 * So the policy and the write disagreed from the day both were written, and the only place
 * that disagreement could appear was production.
 */
const PROBE_ROLE = 'buildcore_selection_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';
const SCHEMA = 'settings';
const TABLE = 'UserCompanySelection';

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(120_000);

describe('the company selection row, under a role that cannot bypass RLS', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const companyA = `E2ECSA${stamp}`;
  const companyB = `E2ECSB${stamp}`;
  const userId = `E2ECSU${stamp}`;

  beforeAll(async () => {
    admin = new PrismaClient();

    const [role] = await admin.$queryRaw<{ rolsuper: boolean }[]>`
      SELECT rolsuper FROM pg_roles WHERE rolname = current_user
    `;
    if (!role?.rolsuper) {
      // eslint-disable-next-line no-console
      console.warn(
        'RLS isolation NOT proven: the current role cannot CREATE ROLE, so the ' +
          'non-superuser probe could not be made. Run this suite as a superuser.',
      );
      return;
    }

    // A leftover role from an interrupted run holds grants and cannot simply be dropped.
    for (const sql of [
      `REVOKE ALL ON "${SCHEMA}"."${TABLE}" FROM "${PROBE_ROLE}"`,
      `REVOKE ALL ON SCHEMA "${SCHEMA}" FROM "${PROBE_ROLE}"`,
      `DROP ROLE IF EXISTS "${PROBE_ROLE}"`,
    ]) {
      try {
        await admin.$executeRawUnsafe(sql);
      } catch {
        // The role does not exist yet, which is the ordinary case.
      }
    }
    await admin.$executeRawUnsafe(
      `CREATE ROLE "${PROBE_ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS ` +
        `PASSWORD '${PROBE_PASSWORD}'`,
    );
    await admin.$executeRawUnsafe(
      `GRANT USAGE ON SCHEMA "${SCHEMA}" TO "${PROBE_ROLE}"`,
    );
    await admin.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "${SCHEMA}"."${TABLE}" TO "${PROBE_ROLE}"`,
    );
    canProbe = true;

    for (const [id, name] of [
      [companyA, 'E2E Selection A'],
      [companyB, 'E2E Selection B'],
    ]) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."Company" ("id","name","shortCode","payrollLockDay","pfEmployerRate","esicEmployerRate","gratuityRate","bonusRate","createdAt","updatedAt")
         VALUES ($1,$2,$3,7,12,3.25,4.81,8.33,NOW(),NOW())`,
        id,
        name,
        id.slice(0, 10),
      );
    }

    probe = new PrismaClient({
      datasources: {
        db: { url: probeUrl(process.env.DATABASE_URL as string) },
      },
    });
  });

  afterAll(async () => {
    if (admin) {
      await admin.$executeRawUnsafe(
        `DELETE FROM "settings"."UserCompanySelection" WHERE "userId" = $1`,
        userId,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "settings"."Company" WHERE "id" IN ($1,$2)`,
        companyA,
        companyB,
      );
    }
    if (probe) await probe.$disconnect();
    if (admin && canProbe) {
      await admin.$executeRawUnsafe(
        `REVOKE ALL ON "${SCHEMA}"."${TABLE}" FROM "${PROBE_ROLE}"`,
      );
      await admin.$executeRawUnsafe(
        `REVOKE ALL ON SCHEMA "${SCHEMA}" FROM "${PROBE_ROLE}"`,
      );
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${PROBE_ROLE}"`);
    }
    if (admin) await admin.$disconnect();
  });

  /** The upsert `CompanySelectionService.select` performs, under a chosen RLS context. */
  async function upsertAs(
    ctx: { isSuperAdmin: boolean; companyId?: string },
    target: string,
  ): Promise<void> {
    await (probe as PrismaClient).$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_super_admin', $1, true)`,
        ctx.isSuperAdmin ? 'true' : 'false',
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_company_id', $1, true)`,
        ctx.companyId ?? '',
      );
      await tx.userCompanySelection.upsert({
        where: { userId },
        create: { userId, companyId: target },
        update: { companyId: target },
      });
    });
  }

  it('created a non-superuser probe, so the rest of this suite means something', () => {
    // Without this the three tests below would pass against a superuser connection, which
    // exempts itself from every policy and proves nothing. That is precisely how this defect
    // reached production.
    expect(canProbe).toBe(true);
  });

  it('switches between companies — the thing that failed on the deployment', async () => {
    await upsertAs({ isSuperAdmin: true }, companyA);
    await upsertAs({ isSuperAdmin: true }, companyB);

    const [row] = await admin.$queryRawUnsafe<{ companyId: string }[]>(
      `SELECT "companyId" FROM "settings"."UserCompanySelection" WHERE "userId" = $1`,
      userId,
    );
    expect(row.companyId).toBe(companyB);
  });

  it('is refused when scoped to the company being switched to, which is what the service used to do', async () => {
    // The defect, pinned. Keeping it as a test rather than a comment is what stops somebody
    // "tidying" the unscoped write back into a tenant-scoped one: the policy and this statement
    // cannot both be satisfied, and that is a property of the row rather than an oversight.
    await upsertAs({ isSuperAdmin: true }, companyA);

    await expect(
      upsertAs({ isSuperAdmin: false, companyId: companyB }, companyB),
    ).rejects.toThrow(/row-level security policy/);
  });

  it('still hides another company’s selection from a tenant-scoped read', async () => {
    // The policy is not pointless — it is the wrong tool for the *write*. Its read half works
    // and must keep working, or the fix above would have traded a broken switcher for a
    // cross-tenant leak.
    await upsertAs({ isSuperAdmin: true }, companyA);

    const visible = await (probe as PrismaClient).$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_super_admin', 'false', true)`,
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_company_id', $1, true)`,
        companyB,
      );
      return tx.$queryRawUnsafe<{ userId: string }[]>(
        `SELECT "userId" FROM "settings"."UserCompanySelection"`,
      );
    });

    expect(visible.map((r) => r.userId)).not.toContain(userId);
  });
});
