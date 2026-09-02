/**
 * Gives one existing account a salary structure, so the payroll half of module 5
 * has something to compute from. NON-DESTRUCTIVE, and a dry run unless told
 * otherwise.
 *
 * Companion to `wire-prod-testuser.ts`, deliberately kept separate rather than
 * folded into it: that script establishes the Company -> Shift -> Site -> Employee
 * chain every `/my/*` endpoint needs, and is already reviewed and run. This one
 * only fills in pay fields on the Employee that script produced. Run wire first.
 *
 * Why this exists: without `basic`/`hra`, a generated payroll run computes to
 * zero, which leaves the salary register, deduction report, the four statutory
 * challans and the TDS screens rendering empty states that cannot be distinguished
 * from a bug.
 *
 * Safety properties, all deliberate:
 *
 *   - No `deleteMany()` of any kind, and no writes to any table other than
 *     `hr.Employee` — a single row, identified by the target account's email.
 *   - **Dry run by default.** It prints the exact field-by-field diff and exits.
 *     Nothing is written until `APPLY=1` is passed.
 *   - **Refuses to overwrite an existing salary** unless `FORCE=1`. An employee
 *     that already has `basic` set is one somebody may be being paid against, and
 *     silently replacing those figures is the one genuinely dangerous thing this
 *     script could do.
 *   - Every figure is overridable by environment variable, so nothing here is
 *     baked in.
 *
 * Usage (from the repo root) — inspect first:
 *
 *   sh -c 'set -a; . ./.env.production.local; set +a; \
 *     USER_EMAIL=testuser@buildcore.dev npx ts-node prisma/seed-prod-testuser-salary.ts'
 *
 * then, if the diff looks right:
 *
 *   sh -c 'set -a; . ./.env.production.local; set +a; \
 *     APPLY=1 USER_EMAIL=testuser@buildcore.dev npx ts-node prisma/seed-prod-testuser-salary.ts'
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const EMAIL = (process.env.USER_EMAIL ?? 'testuser@buildcore.dev')
  .trim()
  .toLowerCase();
const APPLY = process.env.APPLY === '1';
const FORCE = process.env.FORCE === '1';

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) throw new Error(`${name} is not a number: ${raw}`);
  return parsed;
};

/**
 * Defaults chosen to exercise all three of PF, ESIC and professional tax against
 * the backend's own default statutory config:
 *
 *   gross 18,000  ->  ESIC applies (below the 21,000 threshold — note ESIC is a
 *                     threshold, not a cap: above it no contribution is due at all)
 *   basic 10,000  ->  PF applies, and sits below the 15,000 wage ceiling, so the
 *                     capped and uncapped paths give the same answer
 *   gross 18,000  ->  professional tax lands in the top default slab (200/month)
 *
 * TDS will compute to zero at this level, which is correct rather than broken —
 * annual gross of ~216,000 is under the taxable threshold once the standard
 * deduction applies. Raise `SEED_BASIC` if you specifically want to exercise TDS.
 */
const SALARY = {
  basic: num('SEED_BASIC', 10000),
  hra: num('SEED_HRA', 4000),
  conveyanceAllowance: num('SEED_CONVEYANCE', 1600),
  siteAllowance: num('SEED_SITE_ALLOWANCE', 1000),
  specialAllowance: num('SEED_SPECIAL_ALLOWANCE', 1400),
  hoursPerDay: num('SEED_HOURS_PER_DAY', 8),
};

async function main() {
  // The same RLS bypass `src/common/prisma/rls-context.ts` sets for system-level
  // writes. Harmless if the connecting role already bypasses RLS.
  await prisma.$executeRaw`SELECT set_config('app.is_super_admin', 'true', false)`;

  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!user) {
    throw new Error(`No account ${EMAIL} in this database — aborting.`);
  }

  const employee = await prisma.employee.findFirst({ where: { userId: user.id } });
  if (!employee) {
    throw new Error(
      `${EMAIL} has no Employee record. Run prisma/wire-prod-testuser.ts first — ` +
        'it creates the Company -> Shift -> Site -> Employee chain this script fills in.',
    );
  }

  const company = await prisma.company.findUnique({
    where: { id: employee.companyId },
    select: { name: true, shortCode: true },
  });

  console.log('--- TARGET ---');
  console.log('account :', user.email);
  console.log('employee:', employee.employeeCode);
  console.log('company :', company ? `${company.name} (${company.shortCode})` : '(unknown)');
  console.log('active  :', employee.isActive);

  const currently = (v: unknown) => (v === null || v === undefined ? 'NULL' : String(v));

  console.log('\n--- SALARY: CURRENT -> PROPOSED ---');
  const rows: [string, string, string][] = [
    ['basic', currently(employee.basic), String(SALARY.basic)],
    ['hra', currently(employee.hra), String(SALARY.hra)],
    ['conveyanceAllowance', currently(employee.conveyanceAllowance), String(SALARY.conveyanceAllowance)],
    ['siteAllowance', currently(employee.siteAllowance), String(SALARY.siteAllowance)],
    ['specialAllowance', currently(employee.specialAllowance), String(SALARY.specialAllowance)],
    ['hoursPerDay', currently(employee.hoursPerDay), String(SALARY.hoursPerDay)],
    ['calculationMode', currently(employee.calculationMode), 'monthly'],
    ['pfApplicable', currently(employee.pfApplicable), 'true'],
    ['esicApplicable', currently(employee.esicApplicable), 'true'],
    ['uan', currently(employee.uan), employee.uan ?? '(generated placeholder)'],
    ['pfNumber', currently(employee.pfNumber), employee.pfNumber ?? '(generated placeholder)'],
    ['esicNumber', currently(employee.esicNumber), employee.esicNumber ?? '(generated placeholder)'],
  ];
  for (const [field, before, after] of rows) {
    console.log(`  ${field.padEnd(22)} ${before.padEnd(14)} -> ${after}`);
  }

  const gross =
    SALARY.basic +
    SALARY.hra +
    SALARY.conveyanceAllowance +
    SALARY.siteAllowance +
    SALARY.specialAllowance;
  console.log(`\n  monthly gross: ${gross}`);

  // ── the one dangerous case ────────────────────────────────────────────────
  const alreadyPaid = employee.basic !== null && Number(employee.basic) > 0;
  if (alreadyPaid && !FORCE) {
    console.log(
      `\nSTOP: ${employee.employeeCode} already has basic=${employee.basic}. ` +
        'Somebody may be paid against those figures, so this script will not ' +
        'replace them. Re-run with FORCE=1 only if you are certain this is a ' +
        'test account whose pay history does not matter.',
    );
    return;
  }

  /**
   * PF and ESIC each require their identifying number when marked applicable —
   * `EmployeesService.assertStatutoryConsistent()` rejects the pair otherwise, and
   * an inconsistent record would fail at challan generation rather than here.
   * Placeholders are clearly marked as such so nobody mistakes them for real
   * registrations filed with the authorities.
   */
  const suffix = employee.employeeCode.replace(/[^0-9]/g, '').padStart(4, '0');
  const statutory = {
    pfApplicable: true,
    pfUpperLimit: false,
    esicApplicable: true,
    esicUpperLimit: true,
    uan: employee.uan ?? `TESTUAN${suffix}`,
    pfNumber: employee.pfNumber ?? `TESTPF${suffix}`,
    esicNumber: employee.esicNumber ?? `TESTESIC${suffix}`,
  };

  if (!APPLY) {
    console.log(
      '\n--- DRY RUN, nothing written ---\n' +
        'Re-run with APPLY=1 to write exactly the diff above. One UPDATE, one row ' +
        'in hr.Employee; no other table is touched.',
    );
    return;
  }

  await prisma.employee.update({
    where: { id: employee.id },
    data: {
      ...SALARY,
      calculationMode: 'monthly',
      ...statutory,
    },
  });

  console.log(`\n--- APPLIED to ${employee.employeeCode} (no rows deleted) ---`);
  console.log(
    'Next: generate a payroll run for the current period from /dashboard/hr/payroll, ' +
      'then process it — the register, deduction report and challans all read from a ' +
      'processed run and stay empty until one exists.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
