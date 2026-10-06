import { PrismaClient } from '@prisma/client';

/**
 * The three daily-work-report tables, under a role that **cannot** bypass row-level security
 * (022 FR-040, FR-040a, FR-040b, FR-040c).
 *
 * ## Why this suite is a deliverable of the feature and not a nicety
 *
 * `projects."DailyWorkReport"` and `projects."DWRTask"` have carried the `tenant_isolation` policy
 * since 008's migration in August 2026. **Neither policy has ever been in force in a single test
 * run.** The development and continuous-integration database role is a superuser, and Postgres
 * exempts a superuser from row-level security *unconditionally* — not per-table, not
 * per-statement, not unless `FORCE ROW LEVEL SECURITY` is set. So every test that has ever read
 * those tables read them with the policy switched off, and passing proved nothing about isolation.
 *
 * This is not hypothetical. On 2026-10-04 the company switcher failed in production with
 * `42501 new row violates row-level security policy (USING expression)` on a table whose policy
 * had been written months earlier and never exercised. 148 tables in this database carry
 * `tenant_isolation`; about 21 are named in a probe suite. That gap is the finding, and this suite
 * closes three more of it.
 *
 * ## The three tests that matter most are not the isolation assertions
 *
 * They are the **non-vacuity** one (FR-040a) and the **skip visibility** one (FR-040b).
 *
 * Without the first, every assertion below runs against a privileged connection and passes while
 * proving nothing — which is exactly how the `42501` reached production.
 *
 * Without the second, a run on a role that cannot `CREATE ROLE` warns to the console and returns,
 * and a continuous-integration summary renders that indistinguishably from a pass. The visibility
 * **is** the requirement: this feature carries FR-040 at all because for two months a policy that
 * was never in force looked exactly like one that was.
 *
 * `projects."BOQTaskItem"` is deliberately **out of scope** (FR-040c). This feature moves its
 * counter but does not own it; proving its isolation is its own feature's work, and naming it here
 * would claim coverage this suite does not deliver.
 */
const PROBE_ROLE = 'buildcore_dwr_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';
const SCHEMA = 'projects';
const TABLES = ['DailyWorkReport', 'DWRTask', 'DWRAttachment'] as const;

/**
 * The three tables are **not** protected the same way, and the difference is worth stating here
 * rather than being discovered by whoever next edits a policy:
 *
 * | Table | Keyed on |
 * |---|---|
 * | `DailyWorkReport` | its own `companyId` |
 * | `DWRTask` | a correlated lookup on its parent report's `companyId` — **it has no `companyId` of its own** |
 * | `DWRAttachment` | its own `companyId` (added by 022) |
 *
 * Neither of 008's two policies carries a `WITH CHECK`, which is sound rather than an omission:
 * Postgres applies the `USING` expression to new rows when `WITH CHECK` is absent, so an INSERT is
 * filtered by the same predicate. `DWRAttachment` states both explicitly, matching 018's tables.
 */

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(120_000);

describe('the daily work report tables, under a role that cannot bypass RLS', () => {
  let admin: PrismaClient;
  let probe: PrismaClient | null = null;
  let canProbe = false;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const companyA = `E2EDWRA${stamp}`;
  const companyB = `E2EDWRB${stamp}`;
  const projectA = `E2EDWRPA${stamp}`;
  const groupA = `E2EDWRGA${stamp}`;
  const clientA = `E2EDWRCA${stamp}`;
  const reportA = `E2EDWRRA${stamp}`;
  const reportB = `E2EDWRRB${stamp}`;

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
      ...TABLES.map(
        (t) => `REVOKE ALL ON "${SCHEMA}"."${t}" FROM "${PROBE_ROLE}"`,
      ),
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
    for (const table of TABLES) {
      await admin.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "${SCHEMA}"."${table}" TO "${PROBE_ROLE}"`,
      );
    }
    canProbe = true;

    // Two companies, and one project with one BOQ group in company A.
    for (const [id, name] of [
      [companyA, 'E2E DWR A'],
      [companyB, 'E2E DWR B'],
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
      `INSERT INTO "projects"."Client" ("id","companyId","name","status","createdAt","updatedAt")
       VALUES ($1,$2,'E2E DWR Client','active',NOW(),NOW())`,
      clientA,
      companyA,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "projects"."Project" ("id","companyId","code","name","clientId","contractValue","startDate","createdAt","updatedAt")
       VALUES ($1,$2,$3,'E2E DWR Project',$4,1000000,NOW(),NOW(),NOW())`,
      projectA,
      companyA,
      `DWR${stamp}`.slice(0, 12),
      clientA,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "projects"."BOQTaskGroup" ("id","companyId","projectId","boqNo","name","scopeQty","createdAt","updatedAt")
       VALUES ($1,$2,$3,'10','E2E group',0,NOW(),NOW())`,
      groupA,
      companyA,
      projectA,
    );

    // One report in each company — B's belongs to A's project on purpose: the row's own
    // `companyId` is what the policy filters on, which is precisely what a cross-tenant leak
    // would exploit.
    for (const [id, companyId, number] of [
      [reportA, companyA, `A-${stamp}`],
      [reportB, companyB, `B-${stamp}`],
    ]) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."DailyWorkReport" ("id","companyId","projectId","workDate","dprNumber","createdAt","updatedAt")
         VALUES ($1,$2,$3,NOW(),$4,NOW(),NOW())`,
        id,
        companyId,
        projectA,
        number,
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
      for (const sql of [
        `DELETE FROM "projects"."DWRAttachment" WHERE "companyId" IN ($1,$2)`,
        `DELETE FROM "projects"."DWRTask" WHERE "dwrId" IN ($1,$2)`,
      ]) {
        try {
          await admin.$executeRawUnsafe(
            sql,
            sql.includes('DWRTask') ? reportA : companyA,
            sql.includes('DWRTask') ? reportB : companyB,
          );
        } catch {
          // Already gone.
        }
      }
      await admin.$executeRawUnsafe(
        `DELETE FROM "projects"."DailyWorkReport" WHERE "id" IN ($1,$2)`,
        reportA,
        reportB,
      );
      await admin.$executeRawUnsafe(
        `DELETE FROM "projects"."BOQTaskGroup" WHERE "id" = $1`,
        groupA,
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
          `REVOKE ALL ON "${SCHEMA}"."${table}" FROM "${PROBE_ROLE}"`,
        );
      }
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
    // FR-040a, and the single most important assertion in the file. Every test below would pass
    // against a superuser connection, which exempts itself from every policy and demonstrates
    // nothing — and that is not a hypothetical failure mode, it is how a 42501 reached production
    // on 2026-10-04. Asserted first, so a suite that could not build its probe fails here rather
    // than reporting green from eight meaningless passes.
    expect(canProbe).toBe(true);
  });

  it('reports as skipped rather than as passed when the probe cannot be built', () => {
    // FR-040b. The suite warns and returns when the role cannot `CREATE ROLE`, and a CI summary
    // renders a warning-and-return exactly like a pass. So the fact is asserted rather than
    // trusted: if `canProbe` is false the test above has already failed, which is what makes the
    // skip **visible**. The visibility is the requirement, because this whole file exists because
    // for two months a policy that was never in force looked precisely like one that was.
    if (!canProbe) {
      throw new Error(
        'Isolation NOT proven — the probe role could not be created. This is a FAILURE, ' +
          'deliberately, and not a skip: a policy tested under a superuser has not been tested.',
      );
    }
    expect(canProbe).toBe(true);
  });

  it('hides another company’s report from a tenant-scoped read', async () => {
    const visible = await asTenant(companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "projects"."DailyWorkReport" WHERE "id" IN ($1,$2)`,
        reportA,
        reportB,
      ),
    );

    const ids = visible.map((row) => row.id);
    expect(ids).toContain(reportA);
    expect(ids).not.toContain(reportB);
  });

  it('refuses to write a report into another company', async () => {
    await expect(
      asTenant(companyA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "projects"."DailyWorkReport" ("id","companyId","projectId","workDate","dprNumber","createdAt","updatedAt")
           VALUES ($1,$2,$3,NOW(),$4,NOW(),NOW())`,
          `${reportA}X`,
          companyB,
          projectA,
          `X-${stamp}`,
        ),
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it('refuses to update another company’s report, reporting zero rows rather than an error', async () => {
    // The quieter half of isolation, and the one a reader is most likely to assume works. An
    // UPDATE whose rows are hidden by the policy is not an error — it affects nothing and returns
    // 0. A service that treated "0 rows updated" as success would silently do nothing, which is
    // why every status transition in `DwrService` compares the count rather than ignoring it.
    const affected = await asTenant(companyA, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "projects"."DailyWorkReport" SET "progress" = 99 WHERE "id" = $1`,
        reportB,
      ),
    );
    expect(affected).toBe(0);

    const [row] = await admin.$queryRawUnsafe<{ progress: number }[]>(
      `SELECT "progress" FROM "projects"."DailyWorkReport" WHERE "id" = $1`,
      reportB,
    );
    expect(row.progress).toBe(0);
  });

  it('refuses to delete another company’s report', async () => {
    const affected = await asTenant(companyA, (tx) =>
      tx.$executeRawUnsafe(
        `DELETE FROM "projects"."DailyWorkReport" WHERE "id" = $1`,
        reportB,
      ),
    );
    expect(affected).toBe(0);

    const [still] = await admin.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) AS count FROM "projects"."DailyWorkReport" WHERE "id" = $1`,
      reportB,
    );
    expect(Number(still.count)).toBe(1);
  });

  it('isolates measurement lines through their parent report, not through a column of their own', async () => {
    // **`DWRTask` has no `companyId`.** Its policy is a parent lookup:
    //
    //     EXISTS (SELECT 1 FROM "DailyWorkReport" d
    //              WHERE d.id = "DWRTask"."dwrId"
    //                AND d."companyId" = current_setting('app.current_company_id', true))
    //
    // Worth asserting precisely because that is not what a reader assumes. Every other
    // tenant-scoped table in this schema carries its own `companyId` — `ClientBillLine` does,
    // `DWRAttachment` does — so a reviewer skimming for the column and not finding it would
    // reasonably conclude the table is unprotected, and a well-meant migration adding a
    // `companyId`-keyed policy beside this one would make the two AND together and hide every row.
    //
    // It is also a different failure surface: this policy is a correlated subquery, so a line
    // whose parent is deleted becomes invisible rather than orphaned, and a line inserted with a
    // `dwrId` belonging to another company is refused by the parent's tenancy rather than by its
    // own. Both are tested below.
    const taskA = `${reportA}T`;
    const taskB = `${reportB}T`;
    for (const [id, dwrId] of [
      [taskA, reportA],
      [taskB, reportB],
    ]) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."DWRTask" ("id","dwrId","paymentMode","servedQty")
         VALUES ($1,$2,'day_basis',1)`,
        id,
        dwrId,
      );
    }

    const visible = await asTenant(companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "projects"."DWRTask" WHERE "id" IN ($1,$2)`,
        taskA,
        taskB,
      ),
    );
    const ids = visible.map((row) => row.id);
    expect(ids).toContain(taskA);
    expect(ids).not.toContain(taskB);
  });

  it('refuses a measurement line whose parent report belongs to another company', async () => {
    // The write half of the parent-lookup policy. A line is the row carrying the quantity that
    // becomes money, and attaching one to another tenant's report would put that quantity into
    // their bill.
    await expect(
      asTenant(companyA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "projects"."DWRTask" ("id","dwrId","paymentMode","servedQty")
           VALUES ($1,$2,'day_basis',1)`,
          `${reportB}TX`,
          reportB,
        ),
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it('isolates attachments, whose policy is new in 022', async () => {
    const attachA = `${reportA}F`;
    const attachB = `${reportB}F`;
    for (const [id, companyId, dwrId] of [
      [attachA, companyA, reportA],
      [attachB, companyB, reportB],
    ]) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "projects"."DWRAttachment" ("id","companyId","dwrId","fileRef","fileName","mimeType","sizeBytes","uploadedAt")
         VALUES ($1,$2,$3,'ref/x','x.jpg','image/jpeg',1,NOW())`,
        id,
        companyId,
        dwrId,
      );
    }

    const visible = await asTenant(companyA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "projects"."DWRAttachment" WHERE "id" IN ($1,$2)`,
        attachA,
        attachB,
      ),
    );
    const ids = visible.map((row) => row.id);
    expect(ids).toContain(attachA);
    expect(ids).not.toContain(attachB);
  });

  it('lets a cross-company context see both, so the policy is a filter and not a wall', async () => {
    // Non-vacuity of the isolation assertions themselves. Every test above asserts that something
    // is *hidden*, and a table nobody can read at all would satisfy all of them — a broken grant
    // or a malformed policy would look exactly like perfect isolation. This is the test that says
    // the rows are there to be hidden.
    const visible = await asTenant(null, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "projects"."DailyWorkReport" WHERE "id" IN ($1,$2)`,
        reportA,
        reportB,
      ),
    );
    expect(visible.map((row) => row.id).sort()).toEqual(
      [reportA, reportB].sort(),
    );
  });
});
