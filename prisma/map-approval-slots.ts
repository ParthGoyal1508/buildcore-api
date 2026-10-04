/**
 * Maps every approval slot a company's chains name to one of that company's roles —
 * safe to run against a real database, and never overwrites a mapping somebody chose.
 *
 * ## The defect this exists for
 *
 * An approval chain names a *position* ("Site Incharge", "HR Office", "Director") and each
 * company maps that position to one of its own roles, because the client runs two companies
 * that may be staffed differently (016 FR-001a). Until 2026-10-04, company creation mapped
 * **only** `final`, on the reasoning that the other two were not guessable — neither "HR
 * Office" nor "Site Incharge" exists as a role in this system.
 *
 * The reasoning was sound and its cost had never been measured. **Five of the twelve chains a
 * company gets name those two slots** — payroll run, attendance correction, attendance
 * exception, operator fuel recovery — so until an administrator made two settings entries, no
 * payroll could be approved. Checked against the live development database on 2026-10-04:
 * unmapped in *both* companies, three weeks after the spine shipped, because nobody had yet
 * tried to approve a payroll in a company that was seeded rather than migrated.
 *
 * Company creation now seeds all three from `DEFAULT_SLOT_ROLE_NAMES` (the client's answer of
 * 2026-10-04). This script is for the companies that already exist and were created before it.
 *
 * ## Why it is safe
 *
 * - **It only ever fills a gap.** A slot already mapped is left exactly as it is and reported
 *   as kept. Overwriting a deliberate mapping would silently re-route a live chain, and the
 *   symptom would be an approval arriving at the wrong desk rather than an error.
 * - **It writes nothing by default.** Pass `APPLY=1` to write; without it the script reports
 *   what it would do and exits. A script that acts on a production database because somebody
 *   wanted to look at it is the wrong default.
 * - **It skips a slot whose role it cannot find** and says so, rather than failing part-way.
 * - **It counts who holds each mapped role**, because a slot mapped to a role nobody is
 *   assigned to stalls the chain one level *deeper* and more quietly than an unmapped slot
 *   does: the level resolves, the queue is simply empty, and the item sits there with nobody
 *   able to act. That is how the first run of this script found the HR level of every payroll
 *   chain pointing at `HO User`, a role no seeded person held.
 *
 * Usage (from the repo root):
 *
 *   npx ts-node prisma/map-approval-slots.ts            # report only
 *   APPLY=1 npx ts-node prisma/map-approval-slots.ts    # write the missing mappings
 *
 * `DATABASE_URL` is read from the environment as every other script here does.
 */
import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import {
  DEFAULT_SLOT_ROLE_NAMES,
  labelForSlot,
} from '../src/approvals/approval-slots';

const prisma = new PrismaClient();
const APPLY = process.env.APPLY === '1';

async function main(): Promise<void> {
  // Every slot any chain in any company actually names — read from the database rather than
  // from `DEFAULT_COMPANY_CHAINS`, because a company may have had a chain edited by hand and
  // the gap this script closes is about what is configured, not about what the defaults say.
  const levels = await prisma.approvalLevel.findMany({
    select: { slotKey: true, label: true, companyId: true },
  });
  const roles = await prisma.role.findMany({
    select: { id: true, name: true },
  });
  const roleIdByName = new Map(roles.map((r) => [r.name, r.id] as const));
  const roleNameById = new Map(roles.map((r) => [r.id, r.name] as const));
  const companies = await prisma.company.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const holdersByRole = new Map(
    (
      await prisma.userRole.groupBy({
        by: ['roleId'],
        _count: { roleId: true },
      })
    ).map((row) => [row.roleId, row._count.roleId] as const),
  );

  let wouldWrite = 0;
  let unresolved = 0;
  let unheld = 0;

  /** Flags a mapped role nobody holds — see the note on safety above. */
  const holderNote = (roleId: string, roleName: string): string => {
    if ((holdersByRole.get(roleId) ?? 0) > 0) return '';
    unheld += 1;
    return `  !! NOBODY HOLDS "${roleName}" — this level will stall`;
  };

  for (const company of companies) {
    const needed = [
      ...new Set(
        levels.filter((l) => l.companyId === company.id).map((l) => l.slotKey),
      ),
    ].sort();
    const existing = new Map(
      (
        await prisma.roleSlotMapping.findMany({
          where: { companyId: company.id },
          select: { slotKey: true, roleId: true },
        })
      ).map((m) => [m.slotKey, m.roleId] as const),
    );

    console.log(`\n${company.name}`);
    if (needed.length === 0) {
      console.log('  no chains configured — nothing to map');
      continue;
    }

    for (const slotKey of needed) {
      const label = labelForSlot(
        slotKey,
        levels.find((l) => l.companyId === company.id && l.slotKey === slotKey)
          ?.label,
      );
      const already = existing.get(slotKey);
      if (already) {
        console.log(
          `  kept    ${slotKey.padEnd(15)} ${label} → ${
            roleNameById.get(already) ?? already
          }` + holderNote(already, roleNameById.get(already) ?? already),
        );
        continue;
      }

      const roleName = DEFAULT_SLOT_ROLE_NAMES[slotKey];
      const roleId = roleName ? roleIdByName.get(roleName) : undefined;
      if (!roleId) {
        unresolved += 1;
        console.log(
          `  SKIP    ${slotKey.padEnd(15)} ${label} → no default role` +
            (roleName
              ? ` ("${roleName}" not found)`
              : ' defined for this slot'),
        );
        continue;
      }

      wouldWrite += 1;
      if (APPLY) {
        await prisma.roleSlotMapping.upsert({
          where: { companyId_slotKey: { companyId: company.id, slotKey } },
          create: { companyId: company.id, slotKey, roleId },
          update: {},
        });
        console.log(
          `  MAPPED  ${slotKey.padEnd(15)} ${label} → ${roleName}` +
            holderNote(roleId, roleName),
        );
      } else {
        console.log(
          `  would   ${slotKey.padEnd(15)} ${label} → ${roleName}` +
            holderNote(roleId, roleName),
        );
      }
    }
  }

  console.log(
    `\n${APPLY ? 'Wrote' : 'Would write'} ${wouldWrite} mapping(s)` +
      (unresolved
        ? `, ${unresolved} slot(s) left unmapped — see SKIP above`
        : '') +
      (unheld
        ? `, ${unheld} level(s) mapped to a role nobody holds — see above`
        : '') +
      '.',
  );
  if (!APPLY && wouldWrite > 0) {
    console.log('Nothing was written. Re-run with APPLY=1 to apply.');
  }
  // A slot left unmapped is not an error — `APPROVAL_SLOT_UNMAPPED` reports it to whoever
  // tries to decide, naming settings as the cause. But it is worth a non-zero exit so this
  // cannot pass silently in a deployment script.
  if (unresolved > 0 || unheld > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
