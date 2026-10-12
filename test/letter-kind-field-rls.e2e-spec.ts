import { PrismaClient } from '@prisma/client';

/**
 * `settings.LetterKindField`, under a role that **cannot** bypass row-level security
 * (2026-10-12).
 *
 * ## Why this table needed a policy at all
 *
 * It was the one table in the letters feature that shipped without one, because it carries
 * no `companyId` — its tenancy lives on the parent `LetterKind`. So "no column to filter
 * on" became "no policy", and a field row was readable and writable by anybody who could
 * name a kind's id. Latent rather than leaking, since every kind in the product today is
 * product-shipped, but the feature exists to let a company define its own.
 *
 * ## The assertion that matters is the first one
 *
 * The development role is a superuser, and Postgres exempts a superuser from row-level
 * security unconditionally. A probe suite that fails to build its own non-superuser role
 * passes every isolation assertion while proving nothing — which is how a `42501` reached
 * production on 2026-10-04. `canProbe` is asserted before anything else.
 *
 * ## And the fourth test is the pair for the second and third
 *
 * A policy that hid *everything* would satisfy "A cannot see B's fields" perfectly. The
 * shipped kind's fields must stay visible to both companies, because that vocabulary is the
 * product's and every company composes templates against it. Without that test, the
 * tightest possible policy — and the most broken — would read as a pass.
 *
 * Structure is `terms-template-rls`'s, deliberately: a second shape for the same job is a
 * second thing to get subtly wrong.
 */
const PROBE_ROLE = 'buildcore_lkf_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(120_000);

describe('a letter kind’s fields, under a role that cannot bypass RLS', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const companyA = `E2ELKFA${stamp}`;
  const companyB = `E2ELKFB${stamp}`;
  const kindA = `E2ELKFKA${stamp}`;
  const kindB = `E2ELKFKB${stamp}`;
  const kindShipped = `E2ELKFKS${stamp}`;
  const fieldA = `E2ELKFFA${stamp}`;
  const fieldB = `E2ELKFFB${stamp}`;
  const fieldShipped = `E2ELKFFS${stamp}`;

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
      `REVOKE ALL ON "settings"."LetterKindField" FROM "${PROBE_ROLE}"`,
      `REVOKE ALL ON "settings"."LetterKind" FROM "${PROBE_ROLE}"`,
      `REVOKE ALL ON SCHEMA "settings" FROM "${PROBE_ROLE}"`,
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
      `GRANT USAGE ON SCHEMA "settings" TO "${PROBE_ROLE}"`,
    );
    await admin.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "settings"."LetterKindField" TO "${PROBE_ROLE}"`,
    );
    // The policy's own predicate reads the parent kind, so the probe needs to be able to
    // read that table or every evaluation fails with a privilege error rather than a
    // policy decision — which would look like isolation and be nothing of the kind.
    await admin.$executeRawUnsafe(
      `GRANT SELECT ON "settings"."LetterKind" TO "${PROBE_ROLE}"`,
    );
    canProbe = true;

    for (const [id, name] of [
      [companyA, 'E2E LKF A'],
      [companyB, 'E2E LKF B'],
    ]) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."Company" ("id","name","shortCode","payrollLockDay","pfEmployerRate","esicEmployerRate","gratuityRate","bonusRate","createdAt","updatedAt")
         VALUES ($1,$2,$3,7,12,3.25,4.81,8.33,NOW(),NOW())`,
        id,
        name,
        id.slice(0, 10),
      );
    }

    // One kind per company and one product-shipped kind, all three with the same `key` on
    // purpose: the parent's `companyId` is what the policy turns on, and a shared key is
    // exactly what a cross-tenant read would reach for.
    for (const [id, companyId] of [
      [kindA, companyA],
      [kindB, companyB],
      [kindShipped, null],
    ] as const) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."LetterKind" ("id","companyId","key","label","createdAt","updatedAt")
         VALUES ($1,$2,$3,'E2E kind',NOW(),NOW())`,
        id,
        companyId,
        `e2e_lkf_${stamp}_${companyId ?? 'shipped'}`,
      );
    }

    for (const [id, kindId, token] of [
      [fieldA, kindA, 'secretClauseA'],
      [fieldB, kindB, 'secretClauseB'],
      [fieldShipped, kindShipped, 'sharedToken'],
    ]) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."LetterKindField" ("id","letterKindId","token","label","sourceType","createdAt","updatedAt")
         VALUES ($1,$2,$3,'E2E field','manual',NOW(),NOW())`,
        id,
        kindId,
        token,
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
        `DELETE FROM "settings"."LetterKindField" WHERE "letterKindId" IN ($1,$2,$3)`,
        kindA,
        kindB,
        kindShipped,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "settings"."LetterKind" WHERE "id" IN ($1,$2,$3)`,
        kindA,
        kindB,
        kindShipped,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "settings"."Company" WHERE "id" IN ($1,$2)`,
        companyA,
        companyB,
      );
    }
    if (probe) await probe.$disconnect();
    if (admin && canProbe) {
      for (const sql of [
        `REVOKE ALL ON "settings"."LetterKindField" FROM "${PROBE_ROLE}"`,
        `REVOKE ALL ON "settings"."LetterKind" FROM "${PROBE_ROLE}"`,
        `REVOKE ALL ON SCHEMA "settings" FROM "${PROBE_ROLE}"`,
        `DROP ROLE IF EXISTS "${PROBE_ROLE}"`,
      ]) {
        await admin.$executeRawUnsafe(sql);
      }
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

  const tokensVisibleTo = (companyId: string) =>
    asTenant(companyId, (tx) =>
      tx.$queryRawUnsafe<{ token: string }[]>(
        `SELECT "token" FROM "settings"."LetterKindField" WHERE "id" IN ($1,$2,$3) ORDER BY "token"`,
        fieldA,
        fieldB,
        fieldShipped,
      ),
    );

  it('created a non-superuser probe, so the rest of this suite means something', () => {
    // The single most important assertion in the file. Every test below passes against a
    // superuser connection, which exempts itself from every policy and demonstrates
    // nothing. Asserted first, so a suite that could not build its probe fails here
    // rather than reporting green from meaningless passes.
    expect(canProbe).toBe(true);
  });

  it('hides another company’s field vocabulary', async () => {
    const mine = await tokensVisibleTo(companyA);
    expect(mine.map((r) => r.token)).toEqual(['secretClauseA', 'sharedToken']);
  });

  it('hides it in the other direction too', async () => {
    const theirs = await tokensVisibleTo(companyB);
    expect(theirs.map((r) => r.token)).toEqual([
      'secretClauseB',
      'sharedToken',
    ]);
  });

  it('still shows both companies the product-shipped kind’s fields', async () => {
    // The pair for the two above. A policy returning nothing at all would satisfy them
    // both and would empty every template editor in the product.
    const [mine, theirs] = await Promise.all([
      tokensVisibleTo(companyA),
      tokensVisibleTo(companyB),
    ]);
    expect(mine.map((r) => r.token)).toContain('sharedToken');
    expect(theirs.map((r) => r.token)).toContain('sharedToken');
  });

  it('refuses to plant a field on another company’s kind', async () => {
    // The write half, which `WITH CHECK` is what stops. A field planted on somebody
    // else's kind reaches the next letter they compose against it — and a token that
    // resolves to nothing renders as a blank in a signed document, which is
    // indistinguishable from a deliberate omission.
    await expect(
      asTenant(companyA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "settings"."LetterKindField" ("id","letterKindId","token","label","sourceType","createdAt","updatedAt")
           VALUES ($1,$2,'plantedToken','Planted','manual',NOW(),NOW())`,
          `E2ELKFP${stamp}`,
          kindB,
        ),
      ),
    ).rejects.toThrow();

    const landed = await admin.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "settings"."LetterKindField" WHERE "token" = 'plantedToken'`,
    );
    expect(landed).toEqual([]);
  });

  it('lets a company write a field on its own kind', async () => {
    // And the pair for that: `WITH CHECK` must not refuse the legitimate write, or
    // nobody can define a field at all.
    const own = `E2ELKFO${stamp}`;
    await asTenant(companyA, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "settings"."LetterKindField" ("id","letterKindId","token","label","sourceType","createdAt","updatedAt")
         VALUES ($1,$2,'ownToken','Own','manual',NOW(),NOW())`,
        own,
        kindA,
      ),
    );

    const landed = await admin.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "settings"."LetterKindField" WHERE "id" = $1`,
      own,
    );
    expect(landed.map((r) => r.id)).toEqual([own]);
  });
});
