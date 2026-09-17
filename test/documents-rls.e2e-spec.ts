import { PrismaClient } from '@prisma/client';

/**
 * Tenant isolation on 017's five new tables, observed under a role that **cannot**
 * bypass it (T067, T068, Constitution Principle IV, quickstart Pass 9).
 *
 * ## Why this suite exists separately, again
 *
 * Postgres exempts superusers and `BYPASSRLS` roles from every policy *unconditionally*.
 * `ENABLE` and `FORCE` do not apply to them and no error is raised — the rows simply come
 * back. The local development role is a superuser, so a cross-tenant read through the
 * application's own client proves nothing: it returns zero rows because Prisma's
 * `WHERE companyId` filtered them, not because a policy did. **That is what made every
 * pre-016 RLS test in this repository vacuous.**
 *
 * So this creates a real `NOSUPERUSER NOBYPASSRLS` login role and asks the questions with
 * the policies actually in force, in raw SQL with no predicate — because a bare
 * `SELECT * FROM settings."CompanyDocument"` can only be filtered by the policy.
 *
 * T068 goes one step further than 016 did: it **disables a policy and confirms the rows
 * DO appear**, then restores it. A test that passes because the table is empty, or
 * because the grant was never made, looks exactly like a test that passes because
 * isolation works. This is the only way to tell them apart.
 */
const PROBE_ROLE = 'buildcore_doc_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';

/** The five tables 017 adds, with the schema each lives in. */
const NEW_TABLES: { schema: string; table: string }[] = [
  { schema: 'settings', table: 'CompanyDocument' },
  { schema: 'projects', table: 'ProjectDocumentRequirement' },
  { schema: 'settings', table: 'LetterKind' },
  { schema: 'settings', table: 'Signatory' },
  { schema: 'shared', table: 'IssuedLetter' },
];

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(120_000);

describe('017 tenant isolation, under a role that cannot bypass RLS (T067, T068)', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const ids = {
    companyA: `E2EDRA${stamp}`,
    companyB: `E2EDRB${stamp}`,
    typeA: '',
    typeB: '',
    docA: '',
    docB: '',
    kindA: '',
    kindB: '',
    signatoryB: '',
    letterB: '',
  };

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

    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${PROBE_ROLE}"`);
    await admin.$executeRawUnsafe(
      `CREATE ROLE "${PROBE_ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS ` +
        `PASSWORD '${PROBE_PASSWORD}'`,
    );
    for (const schema of ['settings', 'projects', 'shared']) {
      await admin.$executeRawUnsafe(
        `GRANT USAGE ON SCHEMA "${schema}" TO "${PROBE_ROLE}"`,
      );
    }
    for (const { schema, table } of NEW_TABLES) {
      await admin.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}"."${table}" TO "${PROBE_ROLE}"`,
      );
    }
    canProbe = true;

    for (const key of ['A', 'B'] as const) {
      const companyId = key === 'A' ? ids.companyA : ids.companyB;
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."Company" ("id","name","shortCode","payrollLockDay","pfEmployerRate","esicEmployerRate","gratuityRate","bonusRate","createdAt","updatedAt")
         VALUES ($1,$2,$3,7,12,3.25,4.81,8.33,NOW(),NOW())`,
        companyId,
        `E2E DocRLS ${key}`,
        companyId.slice(0, 10),
      );

      const typeId = `${companyId}-type`;
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."DocumentType" ("id","companyId","code","name","isMandatory","hasExpiry","needsNumber","isRestricted","sortOrder","isActive","createdAt","updatedAt")
         VALUES ($1,$2,'GST','GST certificate',false,false,false,false,0,true,NOW(),NOW())`,
        typeId,
        companyId,
      );

      const docId = `${companyId}-doc`;
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."CompanyDocument" ("id","companyId","documentTypeId","fileRef","uploadedByUserId","uploadedAt","isCurrent")
         VALUES ($1,$2,$3,$4,'system',NOW(),true)`,
        docId,
        companyId,
        typeId,
        `e2edr/${key}.pdf`,
      );

      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."ProjectDocumentRequirement" ("id","companyId","documentTypeId","isMandatory","createdAt","updatedAt")
         VALUES ($1,$2,$3,true,NOW(),NOW())`,
        `${companyId}-req`,
        companyId,
        typeId,
      );

      const kindId = `${companyId}-kind`;
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."LetterKind" ("id","companyId","key","label","requiresSignature","requiresApproval","isActive","createdAt","updatedAt")
         VALUES ($1,$2,$3,'Site pass',false,false,true,NOW(),NOW())`,
        kindId,
        companyId,
        `e2edr_pass_${key.toLowerCase()}`,
      );

      const signatoryId = `${companyId}-sig`;
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."Signatory" ("id","companyId","name","title","signatureRef","isActive","createdAt","updatedAt")
         VALUES ($1,$2,'Sunil Agarwal','Director',$3,true,NOW(),NOW())`,
        signatoryId,
        companyId,
        `e2edr/sig-${key}`,
      );

      await admin.$executeRawUnsafe(
        `INSERT INTO "shared"."IssuedLetter" ("id","companyId","letterKindId","subjectType","subjectId","templateId","renderedRef","version","isSuperseded","issuedAt","createdAt")
         VALUES ($1,$2,$3,'vendor',$4,'tpl',$5,1,false,NOW(),NOW())`,
        `${companyId}-letter`,
        companyId,
        kindId,
        `vendor-${key}`,
        `e2edr/letter-${key}.pdf`,
      );

      if (key === 'A') {
        ids.typeA = typeId;
        ids.docA = docId;
        ids.kindA = kindId;
      } else {
        ids.typeB = typeId;
        ids.docB = docId;
        ids.kindB = kindId;
        ids.signatoryB = signatoryId;
        ids.letterB = `${companyId}-letter`;
      }
    }

    probe = new PrismaClient({
      datasources: {
        db: { url: probeUrl(process.env.DATABASE_URL as string) },
      },
    });
    await probe.$connect();
  }, 180_000);

  afterAll(async () => {
    await probe?.$disconnect();
    if (!admin) return;

    for (const companyId of [ids.companyA, ids.companyB]) {
      for (const sql of [
        `DELETE FROM "shared"."IssuedLetter" WHERE "companyId" = $1`,
        `DELETE FROM "settings"."Signatory" WHERE "companyId" = $1`,
        `DELETE FROM "settings"."LetterKind" WHERE "companyId" = $1`,
        `DELETE FROM "projects"."ProjectDocumentRequirement" WHERE "companyId" = $1`,
        `DELETE FROM "settings"."CompanyDocument" WHERE "companyId" = $1`,
        `DELETE FROM "settings"."DocumentType" WHERE "companyId" = $1`,
        `DELETE FROM "settings"."Company" WHERE "id" = $1`,
      ]) {
        await admin.$executeRawUnsafe(sql, companyId).catch(() => undefined);
      }
    }

    if (canProbe) {
      await admin
        .$executeRawUnsafe(`DROP OWNED BY "${PROBE_ROLE}"`)
        .catch(() => undefined);
      await admin
        .$executeRawUnsafe(`DROP ROLE IF EXISTS "${PROBE_ROLE}"`)
        .catch(() => undefined);
    }
    await admin.$disconnect();
  }, 120_000);

  const asCompany = async <T>(
    companyId: string,
    fn: (tx: PrismaClient) => Promise<T>,
    isSuperAdmin = false,
  ): Promise<T> =>
    (probe as PrismaClient).$transaction(async (tx) => {
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
    const [role] = await (probe as PrismaClient).$queryRawUnsafe<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );

    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });

  it('has ENABLE and FORCE on all five new tables', async () => {
    guard();
    const rows = await admin.$queryRawUnsafe<
      {
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }[]
    >(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE (n.nspname, c.relname) IN (${NEW_TABLES.map(
          (_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`,
        ).join(', ')})`,
      ...NEW_TABLES.flatMap((t) => [t.schema, t.table]),
    );

    expect(rows).toHaveLength(NEW_TABLES.length);
    for (const row of rows) {
      // FORCE matters: without it the table OWNER bypasses its own policy, and the
      // application connects as the owner.
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it('hides another company’s statutory documents from an unfiltered read', async () => {
    guard();

    // No WHERE clause. Anything that comes back came back because the policy let it.
    const rows = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string; companyId: string }[]>(
        `SELECT "id", "companyId" FROM "settings"."CompanyDocument"`,
      ),
    );

    expect(rows.map((r) => r.id)).toContain(ids.docA);
    expect(rows.map((r) => r.id)).not.toContain(ids.docB);
    expect(rows.every((r) => r.companyId === ids.companyA)).toBe(true);
  });

  it('hides another company’s letters — who they contracted with and for what', async () => {
    guard();

    const rows = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string; subjectId: string }[]>(
        `SELECT "id", "subjectId" FROM "shared"."IssuedLetter"`,
      ),
    );

    // A competitor's work orders name their vendors and their amounts. This is the row
    // set that most obviously must not cross a tenant boundary.
    expect(rows.map((r) => r.id)).not.toContain(ids.letterB);
    expect(rows.map((r) => r.subjectId)).not.toContain('vendor-B');
  });

  it('hides another company’s signatories and project requirements', async () => {
    guard();

    const [signatories, requirements] = await asCompany(
      ids.companyA,
      async (tx) => [
        await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT "id" FROM "settings"."Signatory"`,
        ),
        await tx.$queryRawUnsafe<{ companyId: string }[]>(
          `SELECT "companyId" FROM "projects"."ProjectDocumentRequirement"`,
        ),
      ],
    );

    expect(signatories.map((r) => r.id)).not.toContain(ids.signatoryB);
    expect(requirements.every((r) => r.companyId === ids.companyA)).toBe(true);
  });

  it('shows product-shipped letter kinds to everyone, and one company’s kinds only to it', async () => {
    guard();

    const rows = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string; companyId: string | null }[]>(
        `SELECT "id", "companyId" FROM "settings"."LetterKind"`,
      ),
    );

    // The `ReminderRule` variant of the policy: `companyId IS NULL` is admitted
    // alongside the tenant match, because a product-shipped kind belongs to no company
    // and every company must see it. If this were a plain tenant policy, every company
    // would lose the fifteen shipped kinds and no letter could be issued at all.
    expect(rows.some((r) => r.companyId === null)).toBe(true);
    expect(rows.map((r) => r.id)).toContain(ids.kindA);
    expect(rows.map((r) => r.id)).not.toContain(ids.kindB);
  });

  it('refuses an UPDATE of another company’s document', async () => {
    guard();

    const affected = await asCompany(ids.companyA, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "settings"."CompanyDocument" SET "isCurrent" = false WHERE "id" = $1`,
        ids.docB,
      ),
    );
    expect(affected).toBe(0);

    const [still] = await admin.$queryRawUnsafe<{ isCurrent: boolean }[]>(
      `SELECT "isCurrent" FROM "settings"."CompanyDocument" WHERE "id" = $1`,
      ids.docB,
    );
    expect(still.isCurrent).toBe(true);
  });

  it('refuses an INSERT attributed to another company', async () => {
    guard();

    await expect(
      asCompany(ids.companyA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "settings"."CompanyDocument" ("id","companyId","documentTypeId","fileRef","uploadedByUserId","uploadedAt","isCurrent")
           VALUES ($1,$2,$3,'smuggled','system',NOW(),false)`,
          `${ids.companyA}-smuggle`,
          ids.companyB,
          ids.typeB,
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('sees nothing at all when no company context is set', async () => {
    guard();

    // Default-deny: an unset `app.current_company_id` must not read as "all".
    const rows = await (probe as PrismaClient).$queryRawUnsafe<
      { id: string }[]
    >(`SELECT "id" FROM "settings"."CompanyDocument"`);
    expect(rows).toHaveLength(0);
  });

  it('IS NOT VACUOUS: disabling the policy makes the hidden rows appear (T068)', async () => {
    guard();

    // The check that separates "isolation works" from "the query returned nothing for
    // some other reason" — an empty table, a missing grant, a typo in the table name.
    // Every one of those produces a passing test above. Only this one distinguishes them.
    const before = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "settings"."CompanyDocument"`,
      ),
    );
    expect(before.map((r) => r.id)).not.toContain(ids.docB);

    await admin.$executeRawUnsafe(
      `ALTER TABLE "settings"."CompanyDocument" DISABLE ROW LEVEL SECURITY`,
    );
    try {
      const during = await asCompany(ids.companyA, (tx) =>
        tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT "id" FROM "settings"."CompanyDocument"`,
        ),
      );
      // Company B's document is RIGHT THERE, visible to company A's context, the moment
      // the policy stops applying. That is the proof the policy was doing the work.
      expect(during.map((r) => r.id)).toContain(ids.docB);
    } finally {
      // Restored in `finally` so a failed assertion cannot leave the table unprotected
      // for every subsequent suite — and FORCE restored too, since DISABLE does not
      // clear it but ENABLE alone would not bring it back if it had.
      await admin.$executeRawUnsafe(
        `ALTER TABLE "settings"."CompanyDocument" ENABLE ROW LEVEL SECURITY`,
      );
      await admin.$executeRawUnsafe(
        `ALTER TABLE "settings"."CompanyDocument" FORCE ROW LEVEL SECURITY`,
      );
    }

    // And isolation is back.
    const after = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "settings"."CompanyDocument"`,
      ),
    );
    expect(after.map((r) => r.id)).not.toContain(ids.docB);
  });
});
