import { PrismaClient } from '@prisma/client';

/**
 * `settings.TermsTemplate`, under a role that **cannot** bypass row-level security (2026-10-11).
 *
 * ## Why this is a gating test and not a nicety
 *
 * The constitution requires a probe for every new table, and this one carries **a company's
 * contract wording**. Without a policy in force, the clauses one company puts on the orders its
 * subcontractors sign — its indemnities, its termination rights, its dispute terms — would be
 * readable by every other tenant in the database.
 *
 * ## The assertion that matters is the first one
 *
 * The development role is a superuser, and Postgres exempts a superuser from row-level security
 * unconditionally. So a probe suite that fails to build its own non-superuser role passes every
 * isolation assertion while proving nothing — which is precisely how a `42501` reached production
 * on 2026-10-04, on a policy written months earlier and never once exercised.
 *
 * `canProbe` is therefore asserted before anything else, so a suite that could not build its probe
 * fails loudly instead of reporting green from meaningless passes. The structure is `dwr-rls`'s,
 * deliberately: a second shape for the same job is a second thing to get subtly wrong.
 */
const PROBE_ROLE = 'buildcore_terms_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';
const SCHEMA = 'settings';
const TABLE = 'TermsTemplate';

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(120_000);

describe('the terms master, under a role that cannot bypass RLS', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const companyA = `E2ETRMA${stamp}`;
  const companyB = `E2ETRMB${stamp}`;
  const termsA = `E2ETRMTA${stamp}`;
  const termsB = `E2ETRMTB${stamp}`;

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
      [companyA, 'E2E Terms A'],
      [companyB, 'E2E Terms B'],
    ]) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."Company" ("id","name","shortCode","payrollLockDay","pfEmployerRate","esicEmployerRate","gratuityRate","bonusRate","createdAt","updatedAt")
         VALUES ($1,$2,$3,7,12,3.25,4.81,8.33,NOW(),NOW())`,
        id,
        name,
        id.slice(0, 10),
      );
    }

    // One set of terms in each company, both for the same document kind on purpose: the row's
    // own `companyId` is what the policy filters on, which is exactly what a cross-tenant read
    // would exploit.
    for (const [id, companyId, body] of [
      [termsA, companyA, 'A: retention 10%, arbitration in Nagpur.'],
      [termsB, companyB, 'B: retention 5%, arbitration in Mumbai.'],
    ]) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."TermsTemplate" ("id","companyId","documentKind","body","createdAt","updatedAt")
         VALUES ($1,$2,'work_order',$3,NOW(),NOW())`,
        id,
        companyId,
        body,
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
        `DELETE FROM "settings"."TermsTemplate" WHERE "id" IN ($1,$2)`,
        termsA,
        termsB,
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

  /** Runs `fn` on the probe connection under a chosen tenant context. */
  async function asTenant<T>(
    companyId: string | null,
    fn: (
      tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
    ) => Promise<T>,
  ): Promise<T> {
    return (probe as PrismaClient).$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_super_admin', $1, true)`,
        companyId === null ? 'true' : 'false',
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_company_id', $1, true)`,
        companyId ?? '',
      );
      return fn(tx);
    });
  }

  it('created a non-superuser probe, so the rest of this suite means something', () => {
    // The single most important assertion in the file. Every test below would pass against a
    // superuser connection, which exempts itself from every policy and demonstrates nothing — and
    // that is not hypothetical, it is how a 42501 reached production on 2026-10-04. Asserted first,
    // so a suite that could not build its probe fails here rather than reporting green.
    expect(canProbe).toBe(true);
  });

  it('shows a company only its own terms', async () => {
    const mine = await asTenant(companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "settings"."TermsTemplate" WHERE "documentKind" = 'work_order'`,
      ),
    );
    // Both rows are work-order terms; only one belongs to company A.
    expect(mine.map((r) => r.id)).toEqual([termsA]);
  });

  it('hides another company’s contract wording', async () => {
    const theirs = await asTenant(companyB, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "settings"."TermsTemplate" WHERE "documentKind" = 'work_order'`,
      ),
    );
    expect(theirs.map((r) => r.id)).toEqual([termsB]);
  });

  it('refuses to write terms into another company', async () => {
    // The write half, which `WITH CHECK` on the policy is what stops. A set of clauses planted in
    // somebody else's tenancy would reach the next order they raise, signed by their
    // subcontractor — a leak in the direction nobody checks.
    await expect(
      asTenant(companyB, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "settings"."TermsTemplate" ("id","companyId","documentKind","body","createdAt","updatedAt")
           VALUES ($1,$2,'purchase_order','Planted.',NOW(),NOW())`,
          `${termsA}X`,
          companyA,
        ),
      ),
    ).rejects.toThrow();
  });
});
