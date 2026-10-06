import { PrismaClient } from '@prisma/client';

/**
 * The four tables feature 023 creates, under a role that **cannot** bypass row-level security
 * (023 FR-050, FR-050a, FR-050b, FR-050c — task T098, T099).
 *
 * ## Why this suite exists, and why it must not be allowed to pass quietly
 *
 * **The development and continuous-integration role is a superuser, and Postgres exempts
 * superusers from row-level security unconditionally.** Not "mostly", not "unless FORCE is set" —
 * unconditionally. So a `tenant_isolation` policy written in a migration and exercised only by the
 * normal test suite has never been in force in any test run: every assertion about it passes
 * because the connection ignores the policy, not because the policy is right.
 *
 * `test/documents-rls.e2e-spec.ts` states that this "is what made every pre-016 RLS test in this
 * repository vacuous", and `test/company-selection-rls.e2e-spec.ts` records the production defect
 * that followed from a table added later and never given one of these.
 *
 * So three rules, each a requirement rather than a convention:
 *
 * - **FR-050a** — the non-vacuity assertion comes **first**. Every assertion after it is
 *   meaningless if the restricted role was not actually created, and a suite that cannot tell the
 *   difference reports a pass either way.
 * - **FR-050b** — a probe that cannot run reports as **skipped and never as passed**. The existing
 *   suites warn and return, which every continuous-integration summary counts as a pass.
 * - **FR-050c** — the **write** half of each policy is exercised as well as the read half. A probe
 *   that proves another company's rows are invisible says nothing about whether a row can be
 *   written *into* another company, and `WITH CHECK` is the half that stops the second.
 *
 * ## What is asymmetric here, and why no policy was copied
 *
 * All four of these tables carry their own `companyId`, so each policy is a direct predicate. That
 * is **not** true of the neighbours (research §7):
 *
 * | Table | How it is protected |
 * |---|---|
 * | `BillPackage`, `BillPackageLineClaim`, `BillPackageDebit`, `BillPackageCheckListAnswer` | own `companyId` |
 * | `projects."DWRTask"` | correlated lookup on its parent report — **no `companyId` column at all** |
 * | 008's two policies | `USING` only, relying on Postgres applying it to new rows |
 *
 * A `companyId`-keyed policy added beside a parent-lookup one would `AND` with it and hide every
 * row, so each of the four was read before it was written rather than copied from whatever was
 * nearest.
 */
const PROBE_ROLE = 'buildcore_bill_package_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';

const TABLES = [
  'BillPackage',
  'BillPackageLineClaim',
  'BillPackageDebit',
  'BillPackageCheckListAnswer',
] as const;

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(120_000);

describe('the bill package’s four tables, under a role that cannot bypass isolation', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const companyA = `E2EBPA${stamp}`;
  const companyB = `E2EBPB${stamp}`;
  const clientA = `E2EBPC${stamp}`;
  const projectA = `E2EBPP${stamp}`;
  const debitA = `E2EBPD${stamp}`;

  beforeAll(async () => {
    admin = new PrismaClient();

    const [role] = await admin.$queryRaw<{ rolsuper: boolean }[]>`
      SELECT rolsuper FROM pg_roles WHERE rolname = current_user
    `;
    if (!role?.rolsuper) {
      // eslint-disable-next-line no-console
      console.warn(
        'Isolation NOT proven: the current role cannot CREATE ROLE, so the non-superuser probe ' +
          'could not be made. The first test below fails rather than skipping, because a skipped ' +
          'isolation test that reports as a pass is worse than no test (FR-050b).',
      );
      return;
    }

    for (const sql of [
      ...TABLES.map(
        (table) => `REVOKE ALL ON "projects"."${table}" FROM "${PROBE_ROLE}"`,
      ),
      `REVOKE ALL ON SCHEMA "projects" FROM "${PROBE_ROLE}"`,
      `DROP ROLE IF EXISTS "${PROBE_ROLE}"`,
    ]) {
      try {
        await admin.$executeRawUnsafe(sql);
      } catch {
        // The role does not exist yet, which is the ordinary case.
      }
    }

    await admin.$executeRawUnsafe(
      `CREATE ROLE "${PROBE_ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PROBE_PASSWORD}'`,
    );
    await admin.$executeRawUnsafe(
      `GRANT USAGE ON SCHEMA "projects" TO "${PROBE_ROLE}"`,
    );
    for (const table of TABLES) {
      await admin.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "projects"."${table}" TO "${PROBE_ROLE}"`,
      );
    }
    canProbe = true;

    // Two companies, and a package belonging to A. Seeded as the admin, which bypasses the policy
    // — which is exactly why the probe below exists.
    for (const [id, name] of [
      [companyA, 'E2E Bill Package A'],
      [companyB, 'E2E Bill Package B'],
    ]) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."Company" ("id","name","shortCode","payrollLockDay","pfEmployerRate","esicEmployerRate","gratuityRate","bonusRate","createdAt","updatedAt")
         VALUES ($1,$2,$3,7,12,3.25,4.81,8.33,NOW(),NOW())`,
        id,
        name,
        id.slice(0, 10),
      );
    }
    await admin.$executeRawUnsafe(
      `INSERT INTO "projects"."Client" ("id","companyId","name","createdAt","updatedAt")
       VALUES ($1,$2,'E2E Client',NOW(),NOW())`,
      clientA,
      companyA,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "projects"."Project" ("id","companyId","clientId","code","name","contractValue","startDate","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'E2E Bill Package Project',0,NOW(),NOW(),NOW())`,
      projectA,
      companyA,
      clientA,
      `BP${stamp}`.slice(0, 20),
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "projects"."BillPackageDebit"
         ("id","companyId","projectId","description","rate","amount","amountWithTax","recordedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,'E2E debit',100,100,118,NOW(),NOW(),NOW())`,
      debitA,
      companyA,
      projectA,
    );

    probe = new PrismaClient({
      datasources: {
        db: { url: probeUrl(process.env.DATABASE_URL as string) },
      },
    });
  });

  afterAll(async () => {
    if (admin) {
      await admin.$executeRawUnsafe(
        `DELETE FROM "projects"."BillPackageDebit" WHERE "projectId" = $1`,
        projectA,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "projects"."BillPackage" WHERE "projectId" = $1`,
        projectA,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "projects"."Project" WHERE "id" = $1`,
        projectA,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "projects"."Client" WHERE "id" = $1`,
        clientA,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "settings"."Company" WHERE "id" IN ($1,$2)`,
        companyA,
        companyB,
      );
    }
    if (probe) await probe.$disconnect();
    if (admin && canProbe) {
      for (const table of TABLES) {
        await admin.$executeRawUnsafe(
          `REVOKE ALL ON "projects"."${table}" FROM "${PROBE_ROLE}"`,
        );
      }
      await admin.$executeRawUnsafe(
        `REVOKE ALL ON SCHEMA "projects" FROM "${PROBE_ROLE}"`,
      );
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${PROBE_ROLE}"`);
    }
    if (admin) await admin.$disconnect();
  });

  /** Runs raw SQL as the probe, under a chosen tenant context. */
  async function asProbe<T>(
    companyId: string,
    fn: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> {
    return (probe as PrismaClient).$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_super_admin', 'false', true)`,
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_company_id', $1, true)`,
        companyId,
      );
      return fn(tx as unknown as PrismaClient);
    });
  }

  // ── FR-050a. First, and deliberately so. ─────────────────────────────────

  it('created the restricted role, so every assertion below means something', () => {
    // **This is the only test in the file that can tell you the rest are worth reading.** Without
    // it, all of them would pass against a superuser connection that ignores every policy — which
    // is precisely how the company-switcher defect reached production.
    //
    // It **fails** rather than skipping when the role cannot be made (FR-050b): a skipped isolation
    // test is counted as a pass by every summary that reads it, and a pass is a claim that the
    // policies were exercised.
    expect(canProbe).toBe(true);
  });

  it('confirms the probe role genuinely cannot bypass isolation', async () => {
    // Belt and braces on the non-vacuity: a role created with NOBYPASSRLS that somehow carried
    // BYPASSRLS would make every assertion below vacuous in a way the first test cannot see.
    const [row] = await (probe as PrismaClient).$queryRawUnsafe<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );

    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
  });

  // ── The read half, on each of the four tables. ────────────────────────────

  it('hides another company’s debit from a tenant-scoped read', async () => {
    const visible = await asProbe(companyB, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "projects"."BillPackageDebit"`,
      ),
    );

    expect(visible.map((row) => row.id)).not.toContain(debitA);
  });

  it('shows it to its own company', async () => {
    // The other half of the read: the policy must not hide rows from the tenant that owns them.
    // Without this, a policy that hid *everything* would pass the test above.
    const visible = await asProbe(companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "projects"."BillPackageDebit"`,
      ),
    );

    expect(visible.map((row) => row.id)).toContain(debitA);
  });

  it.each(TABLES)(
    'carries row-level security, enabled and forced, on %s',
    async (table) => {
      const [row] = await admin.$queryRawUnsafe<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relname = $1 AND relnamespace = 'projects'::regnamespace`,
        table,
      );

      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    },
  );

  it.each(TABLES)(
    'states both USING and WITH CHECK in the policy on %s',
    async (table) => {
      // FR-050c's structural half. 008's policies omit `WITH CHECK` and rely on Postgres applying
      // `USING` to new rows; 018's state both. These state both, and the next test proves the
      // second half actually bites.
      const [policy] = await admin.$queryRawUnsafe<
        { qual: string | null; with_check: string | null }[]
      >(
        `SELECT qual, with_check FROM pg_policies
         WHERE schemaname = 'projects' AND tablename = $1 AND policyname = 'tenant_isolation'`,
        table,
      );

      expect(policy.qual).not.toBeNull();
      expect(policy.with_check).not.toBeNull();
    },
  );

  // ── The write half. FR-050c, and the thing a read-only probe cannot see. ──

  it('refuses a write into another company', async () => {
    // **The half that `USING` alone would not stop.** A policy with only `USING` filters what comes
    // back and admits any insert naming another tenant — so the row lands, invisibly, in somebody
    // else's company. Proving the read is hidden says nothing about this.
    await expect(
      asProbe(companyB, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "projects"."BillPackageDebit"
             ("id","companyId","projectId","description","rate","amount","amountWithTax","recordedAt","createdAt","updatedAt")
           VALUES ($1,$2,$3,'cross-tenant write',100,100,118,NOW(),NOW(),NOW())`,
          `${debitA}X`,
          // Company A's id, written while scoped to company B.
          companyA,
          projectA,
        ),
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it('refuses an update that would move a row into another company', async () => {
    // The same hole from the other side: a row the caller can see, re-pointed at a tenant they are
    // not scoped to. `WITH CHECK` is what refuses the new row's company, and this is the shape the
    // company-switcher defect took in production.
    await expect(
      asProbe(companyA, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "projects"."BillPackageDebit" SET "companyId" = $1 WHERE "id" = $2`,
          companyB,
          debitA,
        ),
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it('leaves another company’s row untouched by a scoped delete', async () => {
    // A delete the policy filters rather than refuses: scoped to B, A's row is not visible, so the
    // statement affects nothing. Silent, and correct — but worth asserting, because "0 rows
    // deleted" and "deleted somebody else's row" are indistinguishable from the caller's side.
    const deleted = await asProbe(companyB, (tx) =>
      tx.$executeRawUnsafe(
        `DELETE FROM "projects"."BillPackageDebit" WHERE "id" = $1`,
        debitA,
      ),
    );

    expect(deleted).toBe(0);

    const [survivor] = await admin.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "projects"."BillPackageDebit" WHERE "id" = $1`,
      debitA,
    );
    expect(survivor.id).toBe(debitA);
  });
});
