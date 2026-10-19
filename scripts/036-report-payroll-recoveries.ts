/**
 * 036 data repair — **report only** (plan.md §4, decision 10). Writes nothing.
 *
 * Lists the damage the pre-036 payroll bugs could have left, so somebody can decide what to repair:
 *
 *   A. F1 — salary advances whose recorded recovery (amount − outstanding balance) disagrees with
 *      what processed runs and bank sheets actually deducted. Before 036 every draft generation
 *      reduced the balance, so a regenerated draft over-recovers on paper.
 *   B. F2 — fuel recoveries, the same comparison per employee (recoveredAmount vs the
 *      `fuelRecoveryDeduction` on processed lines).
 *   C. F4 — reimbursement claims marked paid by a payroll run that cannot have carried them: no line
 *      for the employee in that run, a run whose lines list their claims and not this one, or a
 *      claim decided after the run was last generated.
 *   D. F3 — payslips showing 0 advance recovery where the line recovered one.
 *   E. F5 — loan EMIs marked paid by a run of another company, or by a run whose line for that
 *      employee deducted no EMI.
 *
 * Usage (never against `buildcore` without meaning to — it is read-only, but still):
 *
 *   DATABASE_URL="$DBURL" npx ts-node scripts/036-report-payroll-recoveries.ts
 *
 * **How it guarantees it writes nothing:** every query runs inside one transaction opened with
 * `SET TRANSACTION READ ONLY`, which Postgres enforces — an INSERT/UPDATE/DELETE inside it is an
 * error, not a write. RLS is lifted for the read with the same `app.is_super_admin` setting the
 * application uses, scoped to that transaction.
 */
import { Prisma, PrismaClient } from '@prisma/client';

type Row = Record<string, unknown>;

const LIMIT = 50;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const sections = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRaw`SELECT set_config('app.is_super_admin', 'true', true)`;
        const q = (sql: Prisma.Sql) => tx.$queryRaw<Row[]>(sql);

        // A. Advances, per employee. Recorded = Σ(amount − outstanding) over their advances.
        // Deducted = Σ advanceRecovered on processed/paid regular-run lines + Σ bank-sheet
        // recoveries. Employees with an F&F run are listed separately: F&F folds the advance into
        // its loan line, so the comparison does not hold for them.
        const advances = await q(Prisma.sql`
          WITH recorded AS (
            SELECT a."employeeId", SUM(a."amount" - a."outstandingBalance") AS recorded,
                   COUNT(*) AS advances,
                   STRING_AGG(a."id" || ':' || a."status"::text || ':' || a."outstandingBalance"::text, ', ') AS detail
            FROM "hr"."SalaryAdvance" a
            WHERE a."status" IN ('disbursed', 'closed')
            GROUP BY a."employeeId"
          ),
          deducted AS (
            SELECT li."employeeId", SUM(li."advanceRecovered") AS deducted
            FROM "payroll"."PayrollLineItem" li
            JOIN "payroll"."PayrollRun" r ON r."id" = li."payrollRunId"
            WHERE r."isFnf" = false AND r."status" IN ('processed', 'paid')
            GROUP BY li."employeeId"
          ),
          bank AS (
            SELECT "employeeId", SUM("amount") AS bank
            FROM "payroll"."BankSheetRecovery" GROUP BY "employeeId"
          ),
          drafts AS (
            SELECT li."employeeId", SUM(li."advanceRecovered") AS in_drafts
            FROM "payroll"."PayrollLineItem" li
            JOIN "payroll"."PayrollRun" r ON r."id" = li."payrollRunId"
            WHERE r."isFnf" = false AND r."status" = 'draft'
            GROUP BY li."employeeId"
          ),
          fnf AS (
            SELECT DISTINCT li."employeeId"
            FROM "payroll"."PayrollLineItem" li
            JOIN "payroll"."PayrollRun" r ON r."id" = li."payrollRunId"
            WHERE r."isFnf" = true
          )
          SELECT e."companyId", e."employeeCode", rec."employeeId",
                 rec.recorded::numeric(14,2) AS recorded,
                 (COALESCE(d.deducted, 0) + COALESCE(b.bank, 0))::numeric(14,2) AS deducted,
                 (rec.recorded - COALESCE(d.deducted, 0) - COALESCE(b.bank, 0))::numeric(14,2) AS difference,
                 COALESCE(dr.in_drafts, 0)::numeric(14,2) AS "planInOpenDrafts",
                 (f."employeeId" IS NOT NULL) AS "hasFnf",
                 rec.detail AS advances
          FROM recorded rec
          JOIN "hr"."Employee" e ON e."id" = rec."employeeId"
          LEFT JOIN deducted d ON d."employeeId" = rec."employeeId"
          LEFT JOIN bank b ON b."employeeId" = rec."employeeId"
          LEFT JOIN drafts dr ON dr."employeeId" = rec."employeeId"
          LEFT JOIN fnf f ON f."employeeId" = rec."employeeId"
          WHERE ABS(rec.recorded - COALESCE(d.deducted, 0) - COALESCE(b.bank, 0)) > 0.01
          ORDER BY ABS(rec.recorded - COALESCE(d.deducted, 0) - COALESCE(b.bank, 0)) DESC
        `);

        // B. Fuel recoveries, per employee.
        const fuel = await q(Prisma.sql`
          WITH recorded AS (
            SELECT f."employeeId", f."companyId", SUM(f."recoveredAmount") AS recorded,
                   STRING_AGG(f."id" || ':' || f."status"::text || ':' || f."recoveredAmount"::text || '/' || f."amount"::text, ', ') AS detail
            FROM "plant"."OperatorFuelRecovery" f
            GROUP BY f."employeeId", f."companyId"
          ),
          deducted AS (
            SELECT li."employeeId", r."companyId", SUM(li."fuelRecoveryDeduction") AS deducted
            FROM "payroll"."PayrollLineItem" li
            JOIN "payroll"."PayrollRun" r ON r."id" = li."payrollRunId"
            WHERE r."isFnf" = false AND r."status" IN ('processed', 'paid')
            GROUP BY li."employeeId", r."companyId"
          )
          SELECT rec."companyId", e."employeeCode", rec."employeeId",
                 rec.recorded::numeric(14,2) AS recorded,
                 COALESCE(d.deducted, 0)::numeric(14,2) AS deducted,
                 (rec.recorded - COALESCE(d.deducted, 0))::numeric(14,2) AS difference,
                 rec.detail AS recoveries
          FROM recorded rec
          LEFT JOIN "hr"."Employee" e ON e."id" = rec."employeeId"
          LEFT JOIN deducted d ON d."employeeId" = rec."employeeId" AND d."companyId" = rec."companyId"
          WHERE ABS(rec.recorded - COALESCE(d.deducted, 0)) > 0.01
          ORDER BY ABS(rec.recorded - COALESCE(d.deducted, 0)) DESC
        `);

        // C. Claims paid by a run that cannot have carried them.
        const claims = await q(Prisma.sql`
          SELECT c."companyId", c."id" AS "claimId", c."employeeId", c."amount"::numeric(14,2) AS amount,
                 r."id" AS "runId", r."period",
                 CASE
                   WHEN r."id" IS NULL THEN 'run not found'
                   WHEN li."id" IS NULL THEN 'employee has no line in that run'
                   WHEN cardinality(li."reimbursementClaimIds") > 0
                        AND NOT (c."id" = ANY(li."reimbursementClaimIds")) THEN 'not among the claims the line carried'
                   WHEN cardinality(li."reimbursementClaimIds") = 0
                        AND li."reimbursementTotal" = 0
                        AND r."recoveriesSettledAt" IS NOT NULL THEN 'line carried no claims'
                   WHEN c."decidedAt" IS NOT NULL AND r."generatedAt" IS NOT NULL
                        AND c."decidedAt" > r."generatedAt" THEN 'decided after the run was last generated'
                 END AS reason
          FROM "hr"."ReimbursementClaim" c
          LEFT JOIN "payroll"."PayrollRun" r ON r."id" = substring(c."paymentReference" FROM 9)
          LEFT JOIN "payroll"."PayrollLineItem" li ON li."payrollRunId" = r."id" AND li."employeeId" = c."employeeId"
          WHERE c."status" = 'paid' AND c."paymentReference" LIKE 'payroll:%'
            AND (
              r."id" IS NULL OR li."id" IS NULL
              OR (cardinality(li."reimbursementClaimIds") > 0 AND NOT (c."id" = ANY(li."reimbursementClaimIds")))
              OR (cardinality(li."reimbursementClaimIds") = 0 AND li."reimbursementTotal" = 0 AND r."recoveriesSettledAt" IS NOT NULL)
              OR (c."decidedAt" IS NOT NULL AND r."generatedAt" IS NOT NULL AND c."decidedAt" > r."generatedAt")
            )
          ORDER BY r."period" DESC NULLS FIRST
        `);

        // D. Payslips under-reporting the advance.
        const slips = await q(Prisma.sql`
          SELECT r."companyId", s."employeeId", s."period",
                 li."advanceRecovered"::numeric(14,2) AS "lineAdvance",
                 s."deductionAdvanceRecovery"::numeric(14,2) AS "slipAdvance"
          FROM "payroll"."SalarySlip" s
          JOIN "payroll"."PayrollRun" r ON r."period" = s."period" AND r."isFnf" = false AND r."status" IN ('processed', 'paid')
          JOIN "payroll"."PayrollLineItem" li ON li."payrollRunId" = r."id" AND li."employeeId" = s."employeeId"
          WHERE ABS(li."advanceRecovered" - s."deductionAdvanceRecovery") > 0.01
          ORDER BY s."period" DESC
        `);

        // E. Loan EMIs settled by a run that did not deduct them.
        const loans = await q(Prisma.sql`
          SELECT l."companyId" AS "loanCompanyId", r."companyId" AS "runCompanyId",
                 e."id" AS "entryId", l."id" AS "loanId", l."employeeId", e."month",
                 e."emiAmount"::numeric(14,2) AS emi,
                 CASE
                   WHEN r."id" IS NULL THEN 'run not found'
                   WHEN r."companyId" <> l."companyId" THEN 'run belongs to another company'
                   WHEN li."id" IS NULL THEN 'employee has no line in that run'
                   ELSE 'line deducted no EMI'
                 END AS reason
          FROM "payroll"."LoanScheduleEntry" e
          JOIN "payroll"."Loan" l ON l."id" = e."loanId"
          LEFT JOIN "payroll"."PayrollRun" r ON r."id" = e."paidInPayrollRunId"
          LEFT JOIN "payroll"."PayrollLineItem" li ON li."payrollRunId" = r."id" AND li."employeeId" = l."employeeId"
          WHERE e."status" = 'paid' AND e."paidInPayrollRunId" IS NOT NULL
            AND (r."id" IS NULL OR r."companyId" <> l."companyId" OR li."id" IS NULL OR li."loanEmiDeduction" = 0)
          ORDER BY e."month" DESC
        `);

        const [db] = await q(Prisma.sql`SELECT current_database() AS db`);
        return { db: db.db, advances, fuel, claims, slips, loans };
      },
      { timeout: 120_000 },
    );

    const print = (title: string, rows: Row[]) => {
      console.log(`\n== ${title}: ${rows.length} ==`);
      if (rows.length > 0) console.table(rows.slice(0, LIMIT));
      if (rows.length > LIMIT) console.log(`… ${rows.length - LIMIT} more`);
    };
    console.log(
      `036 payroll recovery report (read-only) — database ${sections.db}`,
    );
    print('A. F1 advances: recorded recovery ≠ deducted', sections.advances);
    print('B. F2 fuel recoveries: recorded ≠ deducted', sections.fuel);
    print(
      'C. F4 claims paid by a run that did not carry them',
      sections.claims,
    );
    print('D. F3 payslips whose advance line ≠ the run line', sections.slips);
    print(
      'E. F5 loan EMIs settled by a run that did not deduct them',
      sections.loans,
    );
    console.log(
      '\nNotes: A/B compare per employee; "difference" > 0 means more was taken off the balance ' +
        'than any processed run or bank sheet deducted (the regenerate-a-draft bug). ' +
        '"planInOpenDrafts" is what open drafts will deduct when processed. Rows with hasFnf need a ' +
        'manual look: F&F folds the advance into its loan line.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
