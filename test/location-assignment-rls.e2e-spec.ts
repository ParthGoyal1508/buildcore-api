import { PrismaClient } from '@prisma/client';

/**
 * Tenant isolation on `hr.EmployeeLocationAssignment`, observed under a role that **cannot** bypass
 * it (020 T031, T041).
 *
 * ## The task this closes, and why its stated obstacle no longer holds
 *
 * T031 verified that the policy objects exist and are forced, and then said the rest plainly:
 *
 * > **The probe-role half is not discharged**: the local `prisma` role is a Postgres superuser and
 * > so bypasses RLS unconditionally, which means no local query can prove the policy *denies*
 * > anything.
 *
 * That was true of a query issued as `prisma`, and it left the guarantee asserted by the policy's
 * existence rather than by its behaviour — which is the same thing that made every pre-016 RLS test
 * in this repository vacuous. It is not true of a role created for the purpose. A superuser can
 * `CREATE ROLE … NOSUPERUSER NOBYPASSRLS`, connect as it, and ask the question with the policies
 * actually in force. `documents-rls.e2e-spec.ts` did that in September and `billing-rls.e2e-spec.ts`
 * did it on 2026-10-03; this is the same shape for the one table left asserting rather than proving.
 *
 * ## What is at stake on this table specifically
 *
 * An `EmployeeLocationAssignment` is which site's geofence a person's attendance is validated
 * against, and whether they are exempt from one at all (`isMobile`). A row readable across a tenant
 * boundary is one company learning where another's staff work; a row **writable** across one is
 * worse — an attacker could exempt somebody else's employee from their fence, and the only symptom
 * would be attendance quietly accepted from anywhere.
 *
 * The write cases below matter more here than on a reporting table for that reason.
 */
const PROBE_ROLE = 'buildcore_loc_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';

const WRITE_TABLES: { schema: string; table: string }[] = [
  { schema: 'settings', table: 'Company' },
  { schema: 'hr', table: 'Employee' },
  { schema: 'hr', table: 'EmployeeLocationAssignment' },
];

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(180_000);

describe('020 location assignments, under a role that cannot bypass RLS (T041)', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const ids = {
    companyA: `E2ELRA${stamp}`,
    companyB: `E2ELRB${stamp}`,
    assignmentA: '',
    assignmentB: '',
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
    for (const schema of ['settings', 'hr']) {
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
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."Company" ("id","name","shortCode","payrollLockDay","pfEmployerRate","esicEmployerRate","gratuityRate","bonusRate","createdAt","updatedAt")
         VALUES ($1,$2,$3,7,12,3.25,4.81,8.33,NOW(),NOW())`,
        companyId,
        `E2E LocRLS ${key}`,
        companyId.slice(0, 10),
      );

      // `EmployeeLocationAssignment.employeeId` **does** carry a foreign key — the first draft of
      // this suite assumed it did not and failed on the insert. `hr.Employee` itself carries none,
      // so one bare row per company is the whole of the fixture.
      await admin.$executeRawUnsafe(
        `INSERT INTO "hr"."Employee" ("id","userId","companyId","siteId","shiftId","employeeCode","updatedAt","createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
        `${companyId}-emp`,
        `${companyId}-user`,
        companyId,
        `${companyId}-site`,
        `${companyId}-shift`,
        `${companyId.slice(0, 12)}-E1`,
      );

      const assignmentId = `${companyId}-assign`;
      await admin.$executeRawUnsafe(
        `INSERT INTO "hr"."EmployeeLocationAssignment" ("id","companyId","employeeId","siteId","isMobile","effectiveFrom","assignedByUserId","createdAt")
         VALUES ($1,$2,$3,$4,$5,NOW(),'system',NOW())`,
        assignmentId,
        companyId,
        `${companyId}-emp`,
        `${companyId}-site`,
        false,
      );

      if (key === 'A') ids.assignmentA = assignmentId;
      else ids.assignmentB = assignmentId;
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
        `DELETE FROM "hr"."EmployeeLocationAssignment" WHERE "companyId" = $1`,
        `DELETE FROM "hr"."Employee" WHERE "companyId" = $1`,
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

  it('proves the probe role really cannot bypass RLS', async () => {
    guard();
    const [role] = await (probe as PrismaClient).$queryRawUnsafe<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );

    // T031 verified the policy exists. This is the part it could not do, and the reason every
    // assertion below means anything.
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });

  it('still has ENABLE and FORCE, as T031 recorded', async () => {
    guard();
    const [row] = await admin.$queryRawUnsafe<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'hr' AND c.relname = 'EmployeeLocationAssignment'`,
    );

    // FORCE matters: without it the table owner bypasses its own policy, and the application
    // connects as the owner.
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
  });

  it('hides another company’s assignments from an unfiltered read', async () => {
    guard();

    // No WHERE clause. Anything that comes back came back because the policy let it.
    const rows = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string; companyId: string }[]>(
        `SELECT "id", "companyId" FROM "hr"."EmployeeLocationAssignment"`,
      ),
    );

    // Which site a company's staff are validated against is where that company works.
    expect(rows.map((r) => r.id)).toContain(ids.assignmentA);
    expect(rows.map((r) => r.id)).not.toContain(ids.assignmentB);
  });

  it('refuses to exempt another company’s employee from their geofence', async () => {
    guard();

    // The write that matters most on this table. `isMobile` is the exemption from fence
    // validation, so a cross-tenant UPDATE here is an attacker switching off somebody else's
    // attendance check — and the only symptom would be punches quietly accepted from anywhere.
    const affected = await asCompany(ids.companyA, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "hr"."EmployeeLocationAssignment" SET "isMobile" = true WHERE "id" = $1`,
        ids.assignmentB,
      ),
    );
    expect(affected).toBe(0);

    const [still] = await admin.$queryRawUnsafe<{ isMobile: boolean }[]>(
      `SELECT "isMobile" FROM "hr"."EmployeeLocationAssignment" WHERE "id" = $1`,
      ids.assignmentB,
    );
    expect(still.isMobile).toBe(false);
  });

  it('refuses an assignment attributed to another company', async () => {
    guard();

    await expect(
      asCompany(ids.companyA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "hr"."EmployeeLocationAssignment" ("id","companyId","employeeId","siteId","isMobile","effectiveFrom","assignedByUserId","createdAt")
           VALUES ($1,$2,$3,NULL,true,NOW(),'smuggled',NOW())`,
          `${ids.companyA}-smuggle`,
          ids.companyB,
          `${ids.companyB}-emp`,
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('sees nothing at all when no company context is set', async () => {
    guard();

    // Default-deny. An unset `app.current_company_id` must not read as "all" — the configuration
    // mistake most likely to reach production is a connection that skipped `set_config`.
    const rows = await (probe as PrismaClient).$queryRawUnsafe<
      { id: string }[]
    >(`SELECT "id" FROM "hr"."EmployeeLocationAssignment"`);
    expect(rows).toHaveLength(0);
  });

  it('IS NOT VACUOUS: disabling the policy makes the hidden row appear', async () => {
    guard();

    // The check that separates "isolation works" from "the query returned nothing for some other
    // reason" — an empty table, a missing grant, a typo in the table name. Every one of those
    // produces a passing test above.
    await admin.$executeRawUnsafe(
      `ALTER TABLE "hr"."EmployeeLocationAssignment" DISABLE ROW LEVEL SECURITY`,
    );
    try {
      const during = await asCompany(ids.companyA, (tx) =>
        tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT "id" FROM "hr"."EmployeeLocationAssignment"`,
        ),
      );
      expect(during.map((r) => r.id)).toContain(ids.assignmentB);
    } finally {
      // Restored in `finally`, with FORCE as well: DISABLE does not clear FORCE, but ENABLE alone
      // would not bring it back if it had.
      await admin.$executeRawUnsafe(
        `ALTER TABLE "hr"."EmployeeLocationAssignment" ENABLE ROW LEVEL SECURITY`,
      );
      await admin.$executeRawUnsafe(
        `ALTER TABLE "hr"."EmployeeLocationAssignment" FORCE ROW LEVEL SECURITY`,
      );
    }

    const after = await asCompany(ids.companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "hr"."EmployeeLocationAssignment"`,
      ),
    );
    expect(after.map((r) => r.id)).not.toContain(ids.assignmentB);
  });
});
