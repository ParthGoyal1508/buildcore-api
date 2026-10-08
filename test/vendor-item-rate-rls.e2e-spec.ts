import { PrismaClient } from '@prisma/client';

/**
 * `inventory.VendorItemRate`, under a role that **cannot** bypass row-level security (028 FR-011).
 *
 * ## Why this is a gating task and not a nicety
 *
 * The constitution's fourth principle is non-negotiable and this feature adds the table, so the
 * phase is not committable until this passes. The reason is not procedural: **an agreed rate is
 * commercial terms**. Without a policy in force, one company's negotiated rates — what each of its
 * suppliers charges it for each material — would be readable by every other tenant in the database.
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
const PROBE_ROLE = 'buildcore_rate_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';
const SCHEMA = 'inventory';
const TABLE = 'VendorItemRate';

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(120_000);

describe('the vendor rate table, under a role that cannot bypass RLS', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const companyA = `E2ERATEA${stamp}`;
  const companyB = `E2ERATEB${stamp}`;
  const categoryA = `E2ERATECAT${stamp}`;
  const itemA = `E2ERATEITEM${stamp}`;
  const rateA = `E2ERATERA${stamp}`;
  const rateB = `E2ERATERB${stamp}`;

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
      [companyA, 'E2E Rate A'],
      [companyB, 'E2E Rate B'],
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
      `INSERT INTO "settings"."ItemCategory" ("id","companyId","name","createdAt","updatedAt")
       VALUES ($1,$2,'E2E Rate Category',NOW(),NOW())`,
      categoryA,
      companyA,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "settings"."Item" ("id","companyId","code","name","categoryId","unit","createdAt","updatedAt")
       VALUES ($1,$2,$3,'E2E Rate Item',$4,'BAG',NOW(),NOW())`,
      itemA,
      companyA,
      `RT${stamp}`.slice(0, 12),
      categoryA,
    );

    // One rate in each company, both against company A's item on purpose: the row's own
    // `companyId` is what the policy filters on, which is exactly what a cross-tenant leak would
    // exploit.
    for (const [id, companyId, rate] of [
      [rateA, companyA, '412.00'],
      [rateB, companyB, '999.00'],
    ]) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "inventory"."VendorItemRate" ("id","companyId","vendorId","itemId","rate","effectiveFrom","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5::numeric,NOW(),NOW(),NOW())`,
        id,
        companyId,
        `vendor-${companyId}`,
        itemA,
        rate,
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
        `DELETE FROM "inventory"."VendorItemRate" WHERE "id" IN ($1,$2)`,
        rateA,
        rateB,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "settings"."Item" WHERE "id" = $1`,
        itemA,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "settings"."ItemCategory" WHERE "id" = $1`,
        categoryA,
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

  it('shows a company only its own agreed rates', async () => {
    const mine = await asTenant(companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "inventory"."VendorItemRate" WHERE "itemId" = $1`,
        itemA,
      ),
    );
    // Both rows point at company A's item; only one belongs to company A.
    expect(mine.map((r) => r.id)).toEqual([rateA]);
  });

  it('hides another company’s rate even when the item is shared', async () => {
    const theirs = await asTenant(companyB, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "inventory"."VendorItemRate" WHERE "itemId" = $1`,
        itemA,
      ),
    );
    expect(theirs.map((r) => r.id)).toEqual([rateB]);
  });

  it('refuses to establish a rate against another company', async () => {
    // The write half. `tenant_isolation` carries no `WITH CHECK`, which is sound rather than an
    // omission: Postgres applies the `USING` expression to new rows when `WITH CHECK` is absent, so
    // an INSERT is filtered by the same predicate. Asserted rather than assumed, because a rate
    // written into somebody else's tenancy is a leak in the direction nobody checks.
    await expect(
      asTenant(companyB, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "inventory"."VendorItemRate" ("id","companyId","vendorId","itemId","rate","effectiveFrom","createdAt","updatedAt")
           VALUES ($1,$2,'vendor-x',$3,1,NOW(),NOW(),NOW())`,
          `${rateA}X`,
          companyA,
          itemA,
        ),
      ),
    ).rejects.toThrow();
  });
});
