/**
 * 041 — load the client data workbook's **Companies** tab as companies and their branches.
 *
 * One row per GST registration; rows sharing a short code are one company (Parth Realcon: five
 * branches, Tirupati Enterprises: seven). The grouping, the head-office choice and every check are
 * in `src/settings/companies/client-companies-import.ts`; this applies the result.
 *
 * Usage:
 *
 *   DATABASE_URL="$DBURL" npx ts-node scripts/import-client-companies.ts <workbook.xlsx>          # dry run
 *   DATABASE_URL="$DBURL" npx ts-node scripts/import-client-companies.ts <workbook.xlsx> --apply  # write
 *
 * **What it writes.** For a company that already exists (matched on short code): its legal name,
 * PAN, CIN and TAN from the head-office row; each branch, matched on GSTIN (a GSTIN-less head
 * office matches the existing head office), created or updated; the head-office flag moved to the
 * chosen row; the company's own address columns re-mirrored from it. A company not in the database
 * is reported and skipped — create it under Settings → Companies first, which seeds everything a
 * company needs.
 *
 * A blank cell leaves what is on file. Re-running is harmless: an unchanged workbook reports no changes. Any problem in the sheet stops
 * the run before anything is written, with every problem listed.
 */
import * as ExcelJS from 'exceljs';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  CompanyPlan,
  planCompanies,
  readCompanyRows,
} from '../src/settings/companies/client-companies-import';
import {
  ensureHeadOffice,
  mirrorHeadOffice,
} from '../src/settings/companies/company-branches';

const BRANCH_FIELDS = [
  'gstin',
  'address',
  'city',
  'state',
  'pinCode',
  'phone',
  'email',
  'website',
  'pfEstablishmentCode',
  'esicCode',
  'professionalTaxRegNumber',
] as const;

async function main() {
  const [file, ...flags] = process.argv.slice(2);
  const apply = flags.includes('--apply');
  if (!file) {
    console.error(
      'Usage: import-client-companies.ts <workbook.xlsx> [--apply]',
    );
    process.exit(2);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet('Companies');
  if (!sheet) throw new Error(`${file} has no "Companies" tab.`);

  const { plans, problems } = planCompanies(readCompanyRows(sheet));
  for (const plan of plans) {
    try {
      settingsData(plan);
    } catch (error) {
      problems.push(`${plan.shortCode}: ${(error as Error).message}`);
    }
  }
  if (problems.length > 0) {
    console.error('The Companies tab needs correcting first:\n');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    let changes = 0;
    for (const plan of plans) {
      changes += await importCompany(prisma, plan, apply);
    }
    console.log(
      `\n${changes === 0 ? 'No changes.' : `${changes} change(s)`}${
        apply ? '' : ' — dry run; pass --apply to write.'
      }`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function importCompany(
  prisma: PrismaClient,
  plan: CompanyPlan,
  apply: boolean,
): Promise<number> {
  const run = async (tx: Prisma.TransactionClient) => {
    // `CompanyBranch` is under FORCE ROW LEVEL SECURITY, which binds the table owner too.
    await tx.$executeRaw`SELECT set_config('app.is_super_admin', 'true', true)`;
    const company = await tx.company.findFirst({
      where: { shortCode: { equals: plan.shortCode, mode: 'insensitive' } },
    });
    if (!company) {
      console.log(
        `${plan.shortCode}: not in this database — create it under Settings first. Skipped.`,
      );
      return 0;
    }
    console.log(`${plan.shortCode} — ${plan.legalName}`);
    let changes = 0;

    const wanted: Record<string, unknown> = {
      ...Object.fromEntries(
        (['pan', 'cin', 'tan'] as const)
          .filter((f) => plan[f])
          .map((f) => [f, plan[f]]),
      ),
      ...settingsData(plan),
    };
    // Decimals compare as text, so 8 on file and 8 on the sheet are not reported as a change.
    const companyData = Object.fromEntries(
      Object.entries(wanted).filter(
        ([f, value]) =>
          String(company[f as keyof typeof company]) !== String(value),
      ),
    );
    if (Object.keys(companyData).length > 0) {
      console.log(`  ~ company ${JSON.stringify(companyData)}`);
      await tx.company.update({ where: { id: company.id }, data: companyData });
      changes++;
    }

    const currentHead = await ensureHeadOffice(tx, company.id);
    let headId = currentHead.id;
    for (const row of plan.branches) {
      const data = Object.fromEntries(
        BRANCH_FIELDS.map((f) => [f, row[f] ?? null]),
      );
      const existing = row.gstin
        ? await tx.companyBranch.findFirst({
            where: { companyId: company.id, gstin: row.gstin },
          })
        : null;
      // The head office already on file — the migration made it from the company's own columns —
      // takes the head-office row when it is the same registration: no GSTIN yet, the same GSTIN,
      // or the same state (a corrected GSTIN for the same office). Otherwise the sheet would leave
      // a stale second branch beside the real one.
      const target =
        existing ??
        (row.isHeadOffice &&
        (!currentHead.gstin ||
          currentHead.gstin === row.gstin ||
          currentHead.state?.toLowerCase() === row.state?.toLowerCase())
          ? currentHead
          : null);
      const mark = `${row.gstin ?? '(no GSTIN)'} ${row.state} ${row.city}${
        row.isHeadOffice ? ' [HEAD OFFICE]' : ''
      }`;
      if (target) {
        // A blank cell leaves what is on file: the sheet adds and corrects, it does not erase a PF
        // code somebody already entered under Settings.
        const given = Object.fromEntries(
          Object.entries(data).filter(([, value]) => value !== null),
        );
        const differs = Object.entries(given).some(
          ([f, value]) =>
            (target[f as (typeof BRANCH_FIELDS)[number]] ?? null) !== value,
        );
        if (differs || !target.isActive) {
          console.log(`  ~ branch ${mark}`);
          await tx.companyBranch.update({
            where: { id: target.id },
            data: { ...given, isActive: true },
          });
          changes++;
        }
        if (row.isHeadOffice) headId = target.id;
      } else {
        console.log(`  + branch ${mark}`);
        const created = await tx.companyBranch.create({
          data: {
            companyId: company.id,
            ...data,
            isHeadOffice: false,
            isActive: true,
          },
        });
        if (row.isHeadOffice) headId = created.id;
        changes++;
      }
    }

    if (headId !== currentHead.id) {
      console.log('  ~ head office moved to the chosen row');
      await tx.companyBranch.update({
        where: { id: currentHead.id },
        data: { isHeadOffice: false },
      });
      await tx.companyBranch.update({
        where: { id: headId },
        data: { isHeadOffice: true },
      });
      changes++;
    }
    await mirrorHeadOffice(tx, company.id);

    // A dry run does everything and then refuses to commit, so it reports exactly what --apply
    // would write — including clashes the database itself would refuse.
    if (!apply) throw new DryRun(changes);
    return changes;
  };

  try {
    return await prisma.$transaction(run, { timeout: 60_000 });
  } catch (error) {
    if (error instanceof DryRun) return error.changes;
    throw error;
  }
}

/**
 * The company-wide settings the tab carries — salary debit account, payroll lock day, labour wage
 * cycle and day hours — checked and converted; a value out of range throws with the reason.
 */
function settingsData(plan: CompanyPlan): Record<string, string | number> {
  const s = plan.settings;
  const out: Record<string, string | number> = {};
  if (s.payrollDebitAccountNumber) {
    // Text, never a number: an account number's leading zero is part of it.
    if (!/^\d{6,20}$/.test(s.payrollDebitAccountNumber)) {
      throw new Error(
        `salary debit account "${s.payrollDebitAccountNumber}" is not 6–20 digits.`,
      );
    }
    out.payrollDebitAccountNumber = s.payrollDebitAccountNumber;
  }
  if (s.payrollLockDay) {
    const day = Number(s.payrollLockDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new Error(
        `payroll lock day "${s.payrollLockDay}" is not a day of the month.`,
      );
    }
    out.payrollLockDay = day;
  }
  if (s.labourWageCycle) {
    const cycle = s.labourWageCycle.toLowerCase();
    if (!['weekly', 'fortnightly', 'monthly'].includes(cycle)) {
      throw new Error(
        `labour wage cycle "${s.labourWageCycle}" is not Weekly, Fortnightly or Monthly.`,
      );
    }
    out.labourWageCycle = cycle;
  }
  for (const field of [
    'labourFullDayHours',
    'labourHalfDayHours',
    'labourStandardHours',
  ] as const) {
    if (!s[field]) continue;
    const hours = Number(s[field]);
    if (!(hours > 0 && hours <= 24)) {
      throw new Error(`${field} "${s[field]}" is not between 0 and 24 hours.`);
    }
    out[field] = hours;
  }
  return out;
}

class DryRun extends Error {
  constructor(readonly changes: number) {
    super('dry run');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
