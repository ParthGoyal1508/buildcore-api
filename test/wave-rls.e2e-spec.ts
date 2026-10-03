import { PrismaClient } from '@prisma/client';

/**
 * Tenant isolation on 019's and 020's remaining tables, under a role that **cannot** bypass it
 * (019 T069, 020 T052).
 *
 * ## The obstacle both tasks recorded, and why it is gone
 *
 * Both said the same thing in different words: *"everything local runs as a Postgres superuser,
 * which is exempt from policies unconditionally, so the policy is verified to exist and be forced
 * but not to deny anything."* True of a query issued as `prisma`, and not true of a role created for
 * the purpose — a superuser can `CREATE ROLE … NOSUPERUSER NOBYPASSRLS` and connect as it.
 * `documents-rls.e2e-spec.ts` established the pattern; `billing-rls` and
 * `location-assignment-rls.e2e-spec.ts` followed on 2026-10-03. This is the same shape for the four
 * tables left asserting rather than proving.
 *
 * ## Table-driven for the structural checks, named for the writes
 *
 * The four checks every tenant table needs — ENABLE and FORCE, an unfiltered read returning only
 * your own rows, default-deny with no company context, and the row appearing when the policy is
 * disabled — are the same question four times, and writing them out four times invites a
 * copy-paste divergence. What is **not** generic is what each table's exposure costs, so the write
 * cases are named individually with the consequence stated.
 *
 * Each table gets its own fixture row in each of two companies and its own vacuity check, so a
 * missing grant or a mistyped name fails rather than passing quietly — the failure mode a generic
 * sweep is most likely to have.
 */
const PROBE_ROLE = 'buildcore_wave_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';

/** One table under probe, with what its exposure would cost. */
interface Probed {
  schema: string;
  table: string;
  /** Which task this table belongs to, for the record. */
  task: string;
  /** Why a cross-tenant read of it matters, in one sentence. */
  atStake: string;
}

const PROBED: Probed[] = [
  {
    schema: 'settings',
    table: 'PermissionRefusal',
    task: '019 T069',
    atStake:
      'every refusal this company’s staff have hit — which modules they tried to reach and were ' +
      'turned away from, which is an inventory of what they are not trusted with',
  },
  {
    schema: 'settings',
    table: 'UserCompanySelection',
    task: '019 T069',
    atStake:
      'which company each cross-company user is currently acting as, which is who is looking at ' +
      'whose books right now',
  },
  {
    schema: 'plant',
    table: 'FuelVarianceException',
    task: '020 T052',
    atStake:
      'every machine this company has flagged for excess fuel, which is an operational weakness ' +
      'list a competitor would read with interest',
  },
  {
    schema: 'plant',
    table: 'OperatorFuelRecovery',
    task: '020 T052',
    atStake:
      'money recovered from a named operator’s salary — a disciplinary record about an individual, ' +
      'and the most personal row in either feature',
  },
];

/** Tables the fixtures must write to, which is wider than what is probed. */
const WRITE_TABLES: { schema: string; table: string }[] = [
  { schema: 'settings', table: 'Company' },
  { schema: 'settings', table: 'EquipmentCategory' },
  { schema: 'plant', table: 'Equipment' },
  { schema: 'plant', table: 'FuelEntry' },
  ...PROBED.map(({ schema, table }) => ({ schema, table })),
];

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(240_000);

describe('019 and 020 tenant isolation, under a role that cannot bypass RLS', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const companyOf = { A: `E2EWRA${stamp}`, B: `E2EWRB${stamp}` } as const;

  /** The fixture row id for one table in one company. Predictable, so assertions can name it. */
  const rowId = (table: string, key: 'A' | 'B') => `${companyOf[key]}-${table}`;

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
    for (const schema of ['settings', 'plant']) {
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
      const companyId = companyOf[key];
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."Company" ("id","name","shortCode","payrollLockDay","pfEmployerRate","esicEmployerRate","gratuityRate","bonusRate","createdAt","updatedAt")
         VALUES ($1,$2,$3,7,12,3.25,4.81,8.33,NOW(),NOW())`,
        companyId,
        `E2E WaveRLS ${key}`,
        companyId.slice(0, 10),
      );

      // ── 019 ────────────────────────────────────────────────────────────────
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."PermissionRefusal" ("id","companyId","userId","method","path","requiredPermission","requiredLevel","createdAt")
         VALUES ($1,$2,$3,'POST',$4,'MACHINERY','write',NOW())`,
        rowId('PermissionRefusal', key),
        companyId,
        `${companyId}-user`,
        `/plant/equipment/secret-${key}`,
      );
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."UserCompanySelection" ("userId","companyId","updatedAt")
         VALUES ($1,$2,NOW())`,
        rowId('UserCompanySelection', key),
        companyId,
      );

      // ── 020 ────────────────────────────────────────────────────────────────
      const categoryId = `${companyId}-cat`;
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."EquipmentCategory" ("id","companyId","name","meterType","fuelVarianceThresholdPercent","targetHoursPerMonth","active","createdAt","updatedAt")
         VALUES ($1,$2,$3,'hours',15,176,true,NOW(),NOW())`,
        categoryId,
        companyId,
        `E2E WaveRLS category ${key}`,
      );
      const equipmentId = `${companyId}-equip`;
      await admin.$executeRawUnsafe(
        `INSERT INTO "plant"."Equipment" ("id","companyId","code","name","categoryId","ownership","powerSource","meterType","currentReading","status","utilizationPercent","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,'owned','diesel','hours',0,'active',0,NOW(),NOW())`,
        equipmentId,
        companyId,
        `${companyId.slice(0, 14)}-EQ`,
        `E2E WaveRLS machine ${key}`,
        categoryId,
      );
      const fuelEntryId = `${companyId}-fuel`;
      await admin.$executeRawUnsafe(
        `INSERT INTO "plant"."FuelEntry" ("id","companyId","equipmentId","date","quantity","rate","amount","varianceAlert","createdAt","updatedAt")
         VALUES ($1,$2,$3,NOW(),80,85.5,6840,true,NOW(),NOW())`,
        fuelEntryId,
        companyId,
        equipmentId,
      );
      await admin.$executeRawUnsafe(
        `INSERT INTO "plant"."FuelVarianceException" ("id","companyId","fuelEntryId","createdAt","updatedAt")
         VALUES ($1,$2,$3,NOW(),NOW())`,
        rowId('FuelVarianceException', key),
        companyId,
        fuelEntryId,
      );
      await admin.$executeRawUnsafe(
        `INSERT INTO "plant"."OperatorFuelRecovery" ("id","companyId","fuelVarianceExceptionId","employeeId","amount","createdByUserId","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,2500,'system',NOW(),NOW())`,
        rowId('OperatorFuelRecovery', key),
        companyId,
        rowId('FuelVarianceException', key),
        `${companyId}-operator`,
      );
    }

    probe = new PrismaClient({
      datasources: {
        db: { url: probeUrl(process.env.DATABASE_URL as string) },
      },
    });
    await probe.$connect();
  }, 300_000);

  afterAll(async () => {
    await probe?.$disconnect();
    if (!admin) return;

    for (const companyId of [companyOf.A, companyOf.B]) {
      for (const sql of [
        `DELETE FROM "plant"."OperatorFuelRecovery" WHERE "companyId" = $1`,
        `DELETE FROM "plant"."FuelVarianceException" WHERE "companyId" = $1`,
        `DELETE FROM "plant"."FuelEntry" WHERE "companyId" = $1`,
        `DELETE FROM "plant"."Equipment" WHERE "companyId" = $1`,
        `DELETE FROM "settings"."EquipmentCategory" WHERE "companyId" = $1`,
        `DELETE FROM "settings"."UserCompanySelection" WHERE "companyId" = $1`,
        `DELETE FROM "settings"."PermissionRefusal" WHERE "companyId" = $1`,
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
  }, 240_000);

  const asCompany = async <T>(
    companyId: string,
    fn: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> =>
    (probe as PrismaClient).$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_super_admin', 'false', true)`,
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

  /** Every id visible on one table under one company's context, with no predicate at all. */
  const idsVisible = async (
    probed: Probed,
    key: 'A' | 'B',
  ): Promise<string[]> => {
    // `UserCompanySelection` is keyed by `userId` and has no `id` column, which is why the column
    // is read from the table rather than assumed. The first draft of this assumed `id` everywhere.
    const column = probed.table === 'UserCompanySelection' ? 'userId' : 'id';
    const rows = await asCompany(companyOf[key], (tx) =>
      tx.$queryRawUnsafe<Record<string, string>[]>(
        `SELECT "${column}" FROM "${probed.schema}"."${probed.table}"`,
      ),
    );
    return rows.map((row) => row[column]);
  };

  it('proves the probe role really cannot bypass RLS', async () => {
    guard();
    const [role] = await (probe as PrismaClient).$queryRawUnsafe<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );

    // First, because every assertion below is meaningless without it — and this is the exact
    // sentence 019 T069 and 020 T052 both said they could not write.
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });

  describe.each(PROBED)('$schema.$table ($task)', (probed) => {
    it('has ENABLE and FORCE', async () => {
      guard();
      const [row] = await admin.$queryRawUnsafe<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        probed.schema,
        probed.table,
      );

      // FORCE matters: without it the table owner bypasses its own policy, and the application
      // connects as the owner.
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    });

    it(`hides the other company's rows from an unfiltered read`, async () => {
      guard();

      // No WHERE clause. Anything that comes back came back because the policy let it. What is at
      // stake here: ${probed.atStake}
      const visible = await idsVisible(probed, 'A');

      expect(visible).toContain(rowId(probed.table, 'A'));
      expect(visible).not.toContain(rowId(probed.table, 'B'));
    });

    it('sees nothing at all when no company context is set', async () => {
      guard();

      // Default-deny. An unset `app.current_company_id` must not read as "all" — the configuration
      // mistake most likely to reach production is a connection that skipped `set_config`.
      const column = probed.table === 'UserCompanySelection' ? 'userId' : 'id';
      const rows = await (probe as PrismaClient).$queryRawUnsafe<
        Record<string, string>[]
      >(`SELECT "${column}" FROM "${probed.schema}"."${probed.table}"`);
      expect(rows).toHaveLength(0);
    });

    it('IS NOT VACUOUS: disabling the policy makes the hidden row appear', async () => {
      guard();

      // Per table, not once for the set. A single vacuity check would pass while a *different*
      // table's policy was missing entirely, which is precisely the failure a table-driven sweep
      // is most likely to have.
      await admin.$executeRawUnsafe(
        `ALTER TABLE "${probed.schema}"."${probed.table}" DISABLE ROW LEVEL SECURITY`,
      );
      try {
        const during = await idsVisible(probed, 'A');
        expect(during).toContain(rowId(probed.table, 'B'));
      } finally {
        // Restored in `finally`, with FORCE as well: DISABLE does not clear FORCE, but ENABLE alone
        // would not bring it back if it had.
        await admin.$executeRawUnsafe(
          `ALTER TABLE "${probed.schema}"."${probed.table}" ENABLE ROW LEVEL SECURITY`,
        );
        await admin.$executeRawUnsafe(
          `ALTER TABLE "${probed.schema}"."${probed.table}" FORCE ROW LEVEL SECURITY`,
        );
      }

      const after = await idsVisible(probed, 'A');
      expect(after).not.toContain(rowId(probed.table, 'B'));
    });
  });

  describe('the writes, named individually because each costs something different', () => {
    it('refuses to switch another company’s acting company (019)', async () => {
      guard();

      // `UserCompanySelection` decides whose books a cross-company user is looking at. A
      // cross-tenant write here moves somebody else's session into a company they did not choose —
      // and every list they then read would be correct for the wrong company.
      const affected = await asCompany(companyOf.A, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "settings"."UserCompanySelection" SET "companyId" = $1 WHERE "userId" = $2`,
          companyOf.A,
          rowId('UserCompanySelection', 'B'),
        ),
      );
      expect(affected).toBe(0);

      const [still] = await admin.$queryRawUnsafe<{ companyId: string }[]>(
        `SELECT "companyId" FROM "settings"."UserCompanySelection" WHERE "userId" = $1`,
        rowId('UserCompanySelection', 'B'),
      );
      expect(still.companyId).toBe(companyOf.B);
    });

    it('refuses to recover fuel money from another company’s operator (020)', async () => {
      guard();

      // The most personal row in either feature: money taken from a named person's salary. A
      // cross-tenant INSERT here is a disciplinary deduction fabricated against somebody else's
      // employee, and it would reach them as a smaller payslip with a reason attached.
      await expect(
        asCompany(companyOf.A, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "plant"."OperatorFuelRecovery" ("id","companyId","fuelVarianceExceptionId","employeeId","amount","createdByUserId","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,99999,'smuggled',NOW(),NOW())`,
            `${companyOf.A}-smuggle`,
            companyOf.B,
            rowId('FuelVarianceException', 'B'),
            `${companyOf.B}-operator`,
          ),
        ),
      ).rejects.toThrow(/row-level security|violates/i);
    });

    it('refuses to clear another company’s fuel exception (020)', async () => {
      guard();

      // Clearing an exception is how an excess-fuel flag stops being chased. Across a tenant
      // boundary it is an attacker making somebody else's losses disappear from their own report.
      const affected = await asCompany(companyOf.A, (tx) =>
        tx.$executeRawUnsafe(
          `DELETE FROM "plant"."FuelVarianceException" WHERE "id" = $1`,
          rowId('FuelVarianceException', 'B'),
        ),
      );
      expect(affected).toBe(0);

      const [[still]] = await Promise.all([
        admin.$queryRawUnsafe<{ id: string }[]>(
          `SELECT "id" FROM "plant"."FuelVarianceException" WHERE "id" = $1`,
          rowId('FuelVarianceException', 'B'),
        ),
      ]);
      expect(still.id).toBe(rowId('FuelVarianceException', 'B'));
    });
  });

  describe('what RolePermission cannot be given, and why that is not an omission', () => {
    it('has no tenant policy, because a role belongs to no company', async () => {
      guard();

      const [row] = await admin.$queryRawUnsafe<
        { relrowsecurity: boolean; hascompany: boolean }[]
      >(
        `SELECT c.relrowsecurity,
                EXISTS (
                  SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'settings'
                     AND table_name = 'RolePermission'
                     AND column_name = 'companyId'
                ) AS hascompany
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'settings' AND c.relname = 'RolePermission'`,
      );

      // 019 T069 says "all three new tables". Two are above. The third is `RolePermission`, and it
      // carries **no `companyId`** — because `settings.Role` carries none either: a role is globally
      // named and shared across companies, which is the divergence recorded in the spec's Key
      // Entities under T071. A tenant policy on this table is not possible, not merely absent, and
      // asserting one would mean inventing a column.
      //
      // Written as a test rather than a comment so that the day somebody adds `companyId` to
      // `Role`, this fails and asks for the policy that then becomes possible.
      expect(row.hascompany).toBe(false);
      expect(row.relrowsecurity).toBe(false);
    });
  });
});
