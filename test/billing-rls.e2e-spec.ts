import { PrismaClient } from '@prisma/client';

/**
 * Tenant isolation on 018's five billing tables, observed under a role that **cannot** bypass it
 * (T051, T052, Constitution Principle IV, quickstart Pass 10).
 *
 * ## Why this suite exists separately
 *
 * Postgres exempts superusers and `BYPASSRLS` roles from every policy *unconditionally*. `ENABLE`
 * and `FORCE` do not apply to them and no error is raised — the rows simply come back. The local
 * development role is a superuser, so a cross-tenant read through the application's own client
 * proves nothing: it returns zero rows because Prisma's `WHERE companyId` filtered them, not because
 * a policy did. **That is what made every pre-016 RLS test in this repository vacuous**, and it is
 * the reason T051's note said to copy `documents-rls.e2e-spec.ts` rather than to write something new.
 *
 * So this creates a real `NOSUPERUSER NOBYPASSRLS` login role and asks the questions with the
 * policies actually in force, in raw SQL with **no predicate** — a bare
 * `SELECT * FROM projects."ClientBill"` can only be filtered by the policy.
 *
 * ## What is specifically at stake on these five tables
 *
 * A competitor's `ClientBill` rows are their contract value, their billing rate per line and how far
 * through the job they are. `WorkOrderBOQItem` is what they pay their subcontractors — the single
 * most commercially sensitive number a construction company holds. This is the row set that most
 * obviously must not cross a tenant boundary, which is why it gets its own suite rather than a
 * paragraph in another.
 *
 * T052 goes a step further than asserting isolation: it **disables a policy and confirms the rows DO
 * appear**, then restores it. A test that passes because the table is empty, or because the grant was
 * never made, or because the table name was mistyped, looks exactly like a test that passes because
 * isolation works. This is the only way to tell them apart.
 */
const PROBE_ROLE = 'buildcore_billing_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';

/** The five tables 018 adds, all in the `projects` schema. */
const BILLING_TABLES = [
  'ClientBill',
  'ClientBillLine',
  'WorkOrderBOQItem',
  'RABillLine',
  'RetentionRelease',
] as const;

/** Everything the fixtures need to insert into, which is wider than what is probed. */
const WRITE_TABLES: { schema: string; table: string }[] = [
  { schema: 'settings', table: 'Company' },
  { schema: 'projects', table: 'Client' },
  { schema: 'projects', table: 'Project' },
  { schema: 'projects', table: 'BOQTaskGroup' },
  { schema: 'projects', table: 'BOQTaskItem' },
  { schema: 'projects', table: 'WorkOrder' },
  { schema: 'projects', table: 'RABill' },
  ...BILLING_TABLES.map((table) => ({ schema: 'projects', table })),
];

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(180_000);

describe('018 tenant isolation, under a role that cannot bypass RLS (T051, T052)', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const ids = {
    companyA: `E2EBRA${stamp}`,
    companyB: `E2EBRB${stamp}`,
    /** Per company, suffixed `-A` / `-B` so every id is predictable from the company id. */
    billA: '',
    billB: '',
    lineA: '',
    lineB: '',
    awardA: '',
    awardB: '',
    raLineA: '',
    raLineB: '',
    releaseA: '',
    releaseB: '',
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
    for (const schema of ['settings', 'projects']) {
      await admin.$executeRawUnsafe(
        `GRANT USAGE ON SCHEMA "${schema}" TO "${PROBE_ROLE}"`,
      );
    }
    for (const { schema, table } of WRITE_TABLES) {
      await admin.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}"."${table}" TO "${PROBE_ROLE}"`,
      );
    }
    canProbe = true;

    for (const key of ['A', 'B'] as const) {
      const companyId = key === 'A' ? ids.companyA : ids.companyB;
      const n = (suffix: string) => `${companyId}-${suffix}`;

      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."Company" ("id","name","shortCode","payrollLockDay","pfEmployerRate","esicEmployerRate","gratuityRate","bonusRate","createdAt","updatedAt")
         VALUES ($1,$2,$3,7,12,3.25,4.81,8.33,NOW(),NOW())`,
        companyId,
        `E2E BillRLS ${key}`,
        companyId.slice(0, 10),
      );

      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."Client" ("id","companyId","name","status","createdAt","updatedAt")
         VALUES ($1,$2,$3,'active',NOW(),NOW())`,
        n('client'),
        companyId,
        `E2E BillRLS client ${key}`,
      );

      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."Project" ("id","companyId","code","name","clientId","contractValue","quotedPercentage","startDate","status","division","siteType","isHO","isLocked","cgstApplicable","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,1000000,0.0246,NOW(),'planning','contract','site',false,false,false,NOW(),NOW())`,
        n('project'),
        companyId,
        `${companyId}-P`,
        `E2E BillRLS project ${key}`,
        n('client'),
      );

      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."BOQTaskGroup" ("id","companyId","projectId","boqNo","name","scopeQty","isEstimate","createdAt","updatedAt")
         VALUES ($1,$2,$3,'1','Structure',100,false,NOW(),NOW())`,
        n('boqgroup'),
        companyId,
        n('project'),
      );

      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."BOQTaskItem" ("id","companyId","groupId","boqNo","taskName","unit","scopeQty","doneQty","rate","isVariation","isEstimate","createdAt","updatedAt")
         VALUES ($1,$2,$3,'1.1','RCC in foundation','Cum',100,0,6200,false,false,NOW(),NOW())`,
        n('boqitem'),
        companyId,
        n('boqgroup'),
      );

      // A client bill and its line: the contract rate per line, and how far through the job.
      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."ClientBill" ("id","companyId","projectId","billNumber","billingDate","quotedPercentage","grossAmount","retentionAmount","netAmount","status","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,NOW(),0.0246,190520,9526,180994,'submitted',NOW(),NOW())`,
        n('bill'),
        companyId,
        n('project'),
        `RLS-${key}-01`,
      );
      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."ClientBillLine" ("id","companyId","clientBillId","boqTaskItemId","quantity","rate","amount","exceedsScope","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,30,6200,190520,false,NOW(),NOW())`,
        n('billline'),
        companyId,
        n('bill'),
        n('boqitem'),
      );

      // A work order, the award under it, a measured RA bill line and a retention release. The award
      // rate is what this company pays its subcontractor — the number a competitor most wants.
      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."WorkOrder" ("id","companyId","projectId","workDetail","retentionPercent","status","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,0.05,'draft',NOW(),NOW())`,
        n('workorder'),
        companyId,
        n('project'),
        `RCC labour, company ${key}`,
      );
      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."WorkOrderBOQItem" ("id","companyId","workOrderId","description","unit","awardedQty","rate","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,'Cum',200,$5,NOW(),NOW())`,
        n('award'),
        companyId,
        n('workorder'),
        `RCC labour rate, company ${key}`,
        key === 'A' ? 1850 : 1620,
      );
      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."RABill" ("id","companyId","projectId","workOrderId","billNumber","amount","billingDate","status","retentionAmount","advanceRecovery","otherDeductions","netPayable","revisionCount","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,55500,NOW(),'submitted',2775,0,0,52725,0,NOW(),NOW())`,
        n('rabill'),
        companyId,
        n('project'),
        n('workorder'),
        `SC-${key}-01`,
      );
      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."RABillLine" ("id","companyId","raBillId","workOrderBoqItemId","quantity","rate","amount","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,30,$5,$6,NOW(),NOW())`,
        n('raline'),
        companyId,
        n('rabill'),
        n('award'),
        key === 'A' ? 1850 : 1620,
        key === 'A' ? 55500 : 48600,
      );
      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."RetentionRelease" ("id","companyId","workOrderId","amount","releasedOn","reason","createdAt")
         VALUES ($1,$2,$3,1000,NOW(),$4,NOW())`,
        n('release'),
        companyId,
        n('workorder'),
        `Half at practical completion, company ${key}`,
      );

      if (key === 'A') {
        ids.billA = n('bill');
        ids.lineA = n('billline');
        ids.awardA = n('award');
        ids.raLineA = n('raline');
        ids.releaseA = n('release');
      } else {
        ids.billB = n('bill');
        ids.lineB = n('billline');
        ids.awardB = n('award');
        ids.raLineB = n('raline');
        ids.releaseB = n('release');
      }
    }

    probe = new PrismaClient({
      datasources: {
        db: { url: probeUrl(process.env.DATABASE_URL as string) },
      },
    });
    await probe.$connect();
  }, 240_000);

  afterAll(async () => {
    await probe?.$disconnect();
    if (!admin) return;

    for (const companyId of [ids.companyA, ids.companyB]) {
      for (const sql of [
        `DELETE FROM "projects"."RetentionRelease" WHERE "companyId" = $1`,
        `DELETE FROM "projects"."RABillLine" WHERE "companyId" = $1`,
        `DELETE FROM "projects"."RABill" WHERE "companyId" = $1`,
        `DELETE FROM "projects"."WorkOrderBOQItem" WHERE "companyId" = $1`,
        `DELETE FROM "projects"."WorkOrder" WHERE "companyId" = $1`,
        `DELETE FROM "projects"."ClientBillLine" WHERE "companyId" = $1`,
        `DELETE FROM "projects"."ClientBill" WHERE "companyId" = $1`,
        `DELETE FROM "projects"."BOQTaskItem" WHERE "companyId" = $1`,
        `DELETE FROM "projects"."BOQTaskGroup" WHERE "companyId" = $1`,
        `DELETE FROM "projects"."Project" WHERE "companyId" = $1`,
        `DELETE FROM "projects"."Client" WHERE "companyId" = $1`,
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
  }, 180_000);

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

  it('proves the probe role really cannot bypass RLS', () => {
    guard();
    return (probe as PrismaClient)
      .$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      )
      .then(([role]) => {
        // Without this, every assertion below passes under a superuser while proving nothing. It is
        // the first test in the file for that reason.
        expect(role.rolsuper).toBe(false);
        expect(role.rolbypassrls).toBe(false);
      });
  });

  it('has ENABLE and FORCE on all five billing tables', async () => {
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
        WHERE n.nspname = 'projects' AND c.relname IN (${BILLING_TABLES.map(
          (_, i) => `$${i + 1}`,
        ).join(', ')})`,
      ...BILLING_TABLES,
    );

    expect(rows).toHaveLength(BILLING_TABLES.length);
    for (const row of rows) {
      // FORCE matters: without it the table OWNER bypasses its own policy, and the application
      // connects as the owner.
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it('hides another company’s client bills — their contract value and their progress', async () => {
    guard();

    // No WHERE clause. Anything that comes back came back because the policy let it.
    const rows = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string; companyId: string }[]>(
        `SELECT "id", "companyId" FROM "projects"."ClientBill"`,
      ),
    );

    expect(rows.map((r) => r.id)).toContain(ids.billA);
    expect(rows.map((r) => r.id)).not.toContain(ids.billB);
    expect(rows.every((r) => r.companyId === ids.companyA)).toBe(true);
  });

  it('hides another company’s billed rates, line by line', async () => {
    guard();

    const rows = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string; rate: unknown }[]>(
        `SELECT "id", "rate" FROM "projects"."ClientBillLine"`,
      ),
    );

    expect(rows.map((r) => r.id)).toContain(ids.lineA);
    expect(rows.map((r) => r.id)).not.toContain(ids.lineB);
  });

  it('hides what another company pays its subcontractors', async () => {
    guard();

    const [awards, lines] = await asCompany(ids.companyA, async (tx) => [
      await tx.$queryRawUnsafe<{ id: string; description: string }[]>(
        `SELECT "id", "description" FROM "projects"."WorkOrderBOQItem"`,
      ),
      await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "projects"."RABillLine"`,
      ),
    ]);

    // The single most commercially sensitive number a construction company holds. Company B's
    // award rate is 1620 against A's 1850 for the same work; either company knowing the other's
    // figure changes what they bid.
    expect(awards.map((r) => r.id)).toContain(ids.awardA);
    expect(awards.map((r) => r.id)).not.toContain(ids.awardB);
    expect(awards.map((r) => r.description).join(' ')).not.toMatch(/company B/);
    expect(lines.map((r) => r.id)).toContain(ids.raLineA);
    expect(lines.map((r) => r.id)).not.toContain(ids.raLineB);
  });

  it('hides another company’s retention ledger', async () => {
    guard();

    const rows = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string; reason: string | null }[]>(
        `SELECT "id", "reason" FROM "projects"."RetentionRelease"`,
      ),
    );

    expect(rows.map((r) => r.id)).toContain(ids.releaseA);
    expect(rows.map((r) => r.id)).not.toContain(ids.releaseB);
  });

  it('refuses an UPDATE of another company’s bill', async () => {
    guard();

    const affected = await asCompany(ids.companyA, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "projects"."ClientBill" SET "grossAmount" = 1 WHERE "id" = $1`,
        ids.billB,
      ),
    );
    // Zero rows, not an error — the row is simply not visible to the statement. The assertion that
    // matters is the one after it: the value did not move.
    expect(affected).toBe(0);

    const [still] = await admin.$queryRawUnsafe<{ grossAmount: unknown }[]>(
      `SELECT "grossAmount" FROM "projects"."ClientBill" WHERE "id" = $1`,
      ids.billB,
    );
    expect(Number(still.grossAmount)).toBe(190520);
  });

  it('refuses a retention release attributed to another company', async () => {
    guard();

    await expect(
      asCompany(ids.companyA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "projects"."RetentionRelease" ("id","companyId","workOrderId","amount","releasedOn","reason","createdAt")
           VALUES ($1,$2,$3,999999,NOW(),'smuggled',NOW())`,
          `${ids.companyA}-smuggle`,
          ids.companyB,
          `${ids.companyB}-workorder`,
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('sees nothing at all when no company context is set', async () => {
    guard();

    // Default-deny: an unset `app.current_company_id` must not read as "all". This is the
    // configuration mistake most likely to happen in production — a connection that skipped
    // `set_config` — and the policy has to fail closed.
    const rows = await (probe as PrismaClient).$queryRawUnsafe<
      { id: string }[]
    >(`SELECT "id" FROM "projects"."ClientBill"`);
    expect(rows).toHaveLength(0);
  });

  it('IS NOT VACUOUS: disabling the policy makes the hidden rows appear (T052)', async () => {
    guard();

    // The check that separates "isolation works" from "the query returned nothing for some other
    // reason" — an empty table, a missing grant, a typo in the table name. Every one of those
    // produces a passing test above. Only this one distinguishes them.
    const before = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "projects"."ClientBill"`,
      ),
    );
    expect(before.map((r) => r.id)).not.toContain(ids.billB);

    await admin.$executeRawUnsafe(
      `ALTER TABLE "projects"."ClientBill" DISABLE ROW LEVEL SECURITY`,
    );
    try {
      const during = await asCompany(ids.companyA, (tx) =>
        tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT "id" FROM "projects"."ClientBill"`,
        ),
      );
      // Company B's bill is RIGHT THERE, visible to company A's context, the moment the policy
      // stops applying. That is the proof the policy was doing the work.
      expect(during.map((r) => r.id)).toContain(ids.billB);
    } finally {
      // Restored in `finally` so a failed assertion cannot leave the table unprotected for every
      // subsequent suite — and FORCE restored too, since DISABLE does not clear it but ENABLE alone
      // would not bring it back if it had.
      await admin.$executeRawUnsafe(
        `ALTER TABLE "projects"."ClientBill" ENABLE ROW LEVEL SECURITY`,
      );
      await admin.$executeRawUnsafe(
        `ALTER TABLE "projects"."ClientBill" FORCE ROW LEVEL SECURITY`,
      );
    }

    // And isolation is back.
    const after = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "projects"."ClientBill"`,
      ),
    );
    expect(after.map((r) => r.id)).not.toContain(ids.billB);
  });

  it('IS NOT VACUOUS on the award table either — the one that matters most (T052)', async () => {
    guard();

    // Done twice, on two tables, deliberately. The first proof could pass while a *different*
    // table's policy was missing entirely, and `WorkOrderBOQItem` is the table whose exposure
    // would cost the most.
    await admin.$executeRawUnsafe(
      `ALTER TABLE "projects"."WorkOrderBOQItem" DISABLE ROW LEVEL SECURITY`,
    );
    try {
      const during = await asCompany(ids.companyA, (tx) =>
        tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT "id" FROM "projects"."WorkOrderBOQItem"`,
        ),
      );
      expect(during.map((r) => r.id)).toContain(ids.awardB);
    } finally {
      await admin.$executeRawUnsafe(
        `ALTER TABLE "projects"."WorkOrderBOQItem" ENABLE ROW LEVEL SECURITY`,
      );
      await admin.$executeRawUnsafe(
        `ALTER TABLE "projects"."WorkOrderBOQItem" FORCE ROW LEVEL SECURITY`,
      );
    }

    const after = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "projects"."WorkOrderBOQItem"`,
      ),
    );
    expect(after.map((r) => r.id)).not.toContain(ids.awardB);
  });

  it('admits a cross-company caller, and only through the super-admin flag', async () => {
    guard();

    // The other half of the policy: `app.is_super_admin = true` sees both. Asserted because a
    // policy that denied this would break the Settings company switcher, and the symptom would be
    // an empty screen for an administrator rather than an error anybody could act on.
    const rows = await asCompany(
      ids.companyA,
      (tx) =>
        tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT "id" FROM "projects"."ClientBill" WHERE "id" IN ($1, $2)`,
          ids.billA,
          ids.billB,
        ),
      true,
    );
    expect(rows.map((r) => r.id).sort()).toEqual([ids.billA, ids.billB].sort());
  });
});
