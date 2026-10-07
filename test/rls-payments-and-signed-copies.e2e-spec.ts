import { PrismaClient } from '@prisma/client';

/**
 * The two tables feature 028 Phase E creates, under a role that **cannot** bypass row-level
 * security (028 FR-020, FR-021 — tasks T043, T044).
 *
 * ## Why one suite for two tables
 *
 * tasks.md names two files. This is one, for the reason `test/ra-bill-package-rls.e2e-spec.ts` is
 * one suite for 023's four tables: the fixture is the same two companies, the same project and the
 * same bill, and a second copy of it is a second thing to keep in step — which is how a probe ends
 * up seeding a company its assertions never read. Both tables are covered in full, each with its
 * read half, its write half and its structural half, which is what the two gating tasks asked for.
 *
 * ## Why these two in particular are worth proving
 *
 * **A payment row is what one company paid one subcontractor, and when.** Leaked, it is the other
 * tenant's cash position and their commercial relationships.
 *
 * **A signed copy is the countersigned document itself**, and its `fileRef` is the key that fetches
 * it back out of storage. A leaked reference is a leaked *document*, not merely a leaked row —
 * which is why the read assertions below select `fileRef` rather than only `id`.
 *
 * ## The first assertion is the one that matters
 *
 * The development role is a superuser, and Postgres exempts a superuser from row-level security
 * **unconditionally**. A suite that fails to build its own non-superuser role therefore passes
 * every isolation assertion while proving nothing — and that is not hypothetical: it is how a
 * `42501` reached production on 2026-10-04, on a policy written months earlier and never once
 * exercised. So `canProbe` is asserted first, and it **fails** rather than skipping (023 FR-050b):
 * a skipped isolation test is counted as a pass by every summary that reads it.
 */
const PROBE_ROLE = 'buildcore_payment_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';

const TABLES = ['RABillPayment', 'SignedCopy'] as const;

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(120_000);

describe('payments and signed copies, under a role that cannot bypass isolation', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const companyA = `E2EPAYA${stamp}`;
  const companyB = `E2EPAYB${stamp}`;
  const clientA = `E2EPAYC${stamp}`;
  const projectA = `E2EPAYP${stamp}`;
  const billA = `E2EPAYB1${stamp}`;
  const paymentA = `E2EPAYM${stamp}`;
  const copyA = `E2EPAYS${stamp}`;
  const copyFileRefA = `signed-copies/${companyA}/secret-reference`;

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
          'isolation test that reports as a pass is worse than no test.',
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

    // Seeded as the admin, which bypasses the policy — which is exactly why the probe exists.
    for (const [id, name] of [
      [companyA, 'E2E Payment A'],
      [companyB, 'E2E Payment B'],
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
       VALUES ($1,$2,'E2E Payment Client',NOW(),NOW())`,
      clientA,
      companyA,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "projects"."Project" ("id","companyId","clientId","code","name","contractValue","startDate","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'E2E Payment Project',0,NOW(),NOW(),NOW())`,
      projectA,
      companyA,
      clientA,
      `PAY${stamp}`.slice(0, 20),
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "projects"."RABill" ("id","companyId","projectId","billNumber","amount","billingDate","createdAt","updatedAt")
       VALUES ($1,$2,$3,'RA-01',100000,NOW(),NOW(),NOW())`,
      billA,
      companyA,
      projectA,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "projects"."RABillPayment" ("id","companyId","raBillId","paidOn","amount","instrument","reference","recordedAt","createdAt","updatedAt")
       VALUES ($1,$2,$3,NOW(),60000,'bank_transfer','UTR-E2E-0001',NOW(),NOW(),NOW())`,
      paymentA,
      companyA,
      billA,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "projects"."SignedCopy" ("id","companyId","subjectType","subjectId","fileRef","fileName","mimeType","sizeBytes","receivedOn","uploadedAt","createdAt","updatedAt")
       VALUES ($1,$2,'ra_bill',$3,$4,'RA-01 signed.pdf','application/pdf',1024,NOW(),NOW(),NOW(),NOW())`,
      copyA,
      companyA,
      billA,
      copyFileRefA,
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
        `DELETE FROM "projects"."SignedCopy" WHERE "companyId" IN ($1,$2)`,
        companyA,
        companyB,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "projects"."RABillPayment" WHERE "companyId" IN ($1,$2)`,
        companyA,
        companyB,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "projects"."RABill" WHERE "projectId" = $1`,
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

  // ── First, and deliberately so. ───────────────────────────────────────────

  it('created the restricted role, so every assertion below means something', () => {
    expect(canProbe).toBe(true);
  });

  it('confirms the probe role genuinely cannot bypass isolation', async () => {
    // Belt and braces: a role created with NOBYPASSRLS that somehow carried BYPASSRLS would make
    // every assertion below vacuous in a way the test above cannot see.
    const [row] = await (probe as PrismaClient).$queryRawUnsafe<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );

    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
  });

  // ── Payments: what one company paid, and when. ────────────────────────────

  it('hides another company’s payment, amount and bank reference', async () => {
    const visible = await asProbe(companyB, (tx) =>
      tx.$queryRawUnsafe<{ id: string; reference: string | null }[]>(
        `SELECT "id", "reference" FROM "projects"."RABillPayment"`,
      ),
    );

    expect(visible.map((row) => row.id)).not.toContain(paymentA);
    // The reference as well as the row: a UTR is how a payment is traced at a bank.
    expect(visible.map((row) => row.reference)).not.toContain('UTR-E2E-0001');
  });

  it('shows the payment to the company that made it', async () => {
    // The other half of the read. Without it, a policy that hid **everything** would pass above.
    const visible = await asProbe(companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "projects"."RABillPayment"`,
      ),
    );

    expect(visible.map((row) => row.id)).toContain(paymentA);
  });

  it('refuses to record a payment into another company', async () => {
    // The write half. A policy with only `USING` filters what comes back and admits an insert
    // naming another tenant — so a payment lands, invisibly, against somebody else's bill.
    await expect(
      asProbe(companyB, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "projects"."RABillPayment" ("id","companyId","raBillId","paidOn","amount","instrument","recordedAt","createdAt","updatedAt")
           VALUES ($1,$2,$3,NOW(),1,'cash',NOW(),NOW(),NOW())`,
          `${paymentA}X`,
          companyA,
          billA,
        ),
      ),
    ).rejects.toThrow();
  });

  // ── Signed copies: the document, not only the row. ────────────────────────

  it('hides another company’s signed copy and its storage reference', async () => {
    const visible = await asProbe(companyB, (tx) =>
      tx.$queryRawUnsafe<{ id: string; fileRef: string }[]>(
        `SELECT "id", "fileRef" FROM "projects"."SignedCopy"`,
      ),
    );

    expect(visible.map((row) => row.id)).not.toContain(copyA);
    // **The reference is the document.** `StorageService.get` takes exactly this string, so a row
    // hidden while its `fileRef` leaked would be a countersigned contract handed to another tenant.
    expect(visible.map((row) => row.fileRef)).not.toContain(copyFileRefA);
  });

  it('shows the signed copy to the company it was filed in', async () => {
    const visible = await asProbe(companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string; fileRef: string }[]>(
        `SELECT "id", "fileRef" FROM "projects"."SignedCopy"`,
      ),
    );

    expect(visible.map((row) => row.id)).toContain(copyA);
    expect(visible.map((row) => row.fileRef)).toContain(copyFileRefA);
  });

  it('refuses to file a signed copy into another company', async () => {
    await expect(
      asProbe(companyB, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "projects"."SignedCopy" ("id","companyId","subjectType","subjectId","fileRef","fileName","mimeType","sizeBytes","receivedOn","uploadedAt","createdAt","updatedAt")
           VALUES ($1,$2,'ra_bill',$3,'x','x.pdf','application/pdf',1,NOW(),NOW(),NOW(),NOW())`,
          `${copyA}X`,
          companyA,
          billA,
        ),
      ),
    ).rejects.toThrow();
  });

  // ── Structural, on both. ──────────────────────────────────────────────────

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
});
