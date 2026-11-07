/**
 * Sets the database up the way the client's roles sheet says (2026-11-07):
 *
 * 1. Creates the module roles that are missing (`npm run roles:modules` does the same alone).
 * 2. Writes the seven sheet roles (`CLIENT_ROLES`): permissions, levels and "works in all
 *    companies". An existing role of that name is rewritten to match the sheet.
 * 3. Approvals: maps the `hr` slot to Operations Manager in every company, and brings every chain
 *    to its default shape — what an employee asks for themselves goes Operations Manager →
 *    Director, what a department enters goes to the Director alone. Items already part-way
 *    through keep the chain they entered.
 * 4. Removes every other role (`rolesToRemove`) and the accounts that held them:
 *    - an account left with nothing but General User (or nothing at all) goes;
 *    - an account that also holds a kept role, or Super Admin, only loses the removed role;
 *    - an account with **no** history (no audit entry, no approval) is deleted;
 *    - an account **with** history is retired instead: deactivated, its login freed for the new
 *      user, its name kept so past entries still say who made them.
 *    Either way the employee record it was linked to is unlinked, so a new login can be linked.
 *
 * **Writes nothing unless `APPLY=1`.** Without it the script prints what it would do.
 *
 * Usage (from the repo root):
 *
 *   npm run roles:client                                   # local database, report only
 *   APPLY=1 npm run roles:client                           # local database, write
 *   APPLY=1 npm run roles:client -- --host <db host>       # a remote database, named on purpose
 */
import 'dotenv/config';

import {
  ApprovalState,
  AuditAction,
  AuditEntityType,
  Prisma,
  PrismaClient,
  UserStatus,
} from '@prisma/client';

import { SLOT_HR } from '../src/approvals/approval-slots';
import { DEFAULT_COMPANY_CHAINS } from '../src/approvals/default-chains';
import {
  CLIENT_ROLES,
  rolesToRemove,
} from '../src/settings/roles/client-roles';
import { moduleRoles } from '../src/settings/roles/module-roles';

const APPLY = process.env.APPLY === '1';
const OPERATIONS_MANAGER = 'Operations Manager';

/**
 * Every chain is brought back to its default shape (2026-11-07). The client's rule: what an employee
 * asks for themselves goes Operations Manager → Director; what a department enters goes to the
 * Director alone. Chains customised before then (a "Head Office" first step on bills, letters and
 * DWRs, a "Site Incharge" step on RA bills) would otherwise send department work to the Operations
 * Manager — or, for an RA bill, to a role that no longer exists.
 */
const CHANGED_ACTIONS = new Set(
  DEFAULT_COMPANY_CHAINS.map(([actionType]) => actionType),
);

function assertTarget(): void {
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return;
  const flag = process.argv.indexOf('--host');
  const named = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (named !== host) {
    throw new Error(
      `Refusing ${host}: a non-local database must be named on purpose. ` +
        `Re-run with --host ${host} if this is the database you mean.`,
    );
  }
}

const prisma = new PrismaClient();

/** Every statement below runs as Super Admin: the tables are under FORCE RLS. */
async function asSuperAdmin<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_super_admin', 'true', true)`;
      return work(tx);
    },
    { timeout: 120_000 },
  );
}

const levelKey = (
  levels: {
    position: number;
    slotKey: string;
    label?: string | null;
    isFinalAuthority?: boolean;
  }[],
) =>
  [...levels]
    .sort((a, b) => a.position - b.position)
    .map(
      (l) =>
        `${l.slotKey}:${l.label ?? ''}:${l.isFinalAuthority ? 'final' : ''}`,
    )
    .join(' → ');

async function main(): Promise<void> {
  assertTarget();
  console.log(
    APPLY
      ? 'APPLYING CHANGES\n'
      : 'REPORT ONLY — nothing is written (APPLY=1 to write)\n',
  );

  // ---------------------------------------------------------------- 1. module roles
  const globalNames = new Set(
    (
      await asSuperAdmin((tx) =>
        tx.role.findMany({
          where: { companyId: null },
          select: { name: true },
        }),
      )
    ).map((r) => r.name),
  );
  const missingModule = moduleRoles().filter((r) => !globalNames.has(r.name));
  console.log(`Module roles to create: ${missingModule.length}`);
  if (APPLY && missingModule.length > 0) {
    await asSuperAdmin(async (tx) => {
      for (const role of missingModule) {
        await tx.role.create({
          data: {
            name: role.name,
            companyId: null,
            permissions: [role.permission],
            rolePermissions: {
              create: role.levels.map((level) => ({
                permission: role.permission,
                level,
              })),
            },
          },
        });
      }
    });
  }

  // ---------------------------------------------------------------- 2. the sheet's roles
  console.log('\nSheet roles:');
  await asSuperAdmin(async (tx) => {
    for (const role of CLIENT_ROLES) {
      const existing = await tx.role.findFirst({
        where: { name: role.name, companyId: null },
        select: { id: true },
      });
      const permissions = role.grants.map(([p]) => p);
      const rows = role.grants.flatMap(([permission, levels]) =>
        levels.map((level) => ({ permission, level })),
      );
      console.log(
        `  ${existing ? 'rewrite' : 'create '} ${role.name}${
          role.allCompanies ? ' (both companies)' : ''
        }: ${permissions.join(', ')}`,
      );
      if (!APPLY) continue;
      if (existing) {
        await tx.rolePermission.deleteMany({ where: { roleId: existing.id } });
        await tx.role.update({
          where: { id: existing.id },
          data: {
            permissions,
            allCompanies: role.allCompanies,
            rolePermissions: { create: rows },
          },
        });
      } else {
        await tx.role.create({
          data: {
            name: role.name,
            companyId: null,
            permissions,
            allCompanies: role.allCompanies,
            rolePermissions: { create: rows },
          },
        });
      }
    }
  });

  // ---------------------------------------------------------------- 3. approvals
  const operationsManager = APPLY
    ? await asSuperAdmin((tx) =>
        tx.role.findFirst({
          where: { name: OPERATIONS_MANAGER, companyId: null },
          select: { id: true },
        }),
      )
    : { id: '(Operations Manager)' };
  const companies = await asSuperAdmin((tx) =>
    tx.company.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  );
  const defaults = new Map(DEFAULT_COMPANY_CHAINS);
  console.log('\nApprovals:');
  for (const company of companies) {
    await asSuperAdmin(async (tx) => {
      console.log(`  ${company.name}: "hr" slot → ${OPERATIONS_MANAGER}`);
      if (APPLY && operationsManager) {
        await tx.roleSlotMapping.upsert({
          where: {
            companyId_slotKey: { companyId: company.id, slotKey: SLOT_HR },
          },
          create: {
            companyId: company.id,
            slotKey: SLOT_HR,
            roleId: operationsManager.id,
          },
          update: { roleId: operationsManager.id },
        });
      }
      const chains = await tx.approvalChain.findMany({
        where: {
          companyId: company.id,
          isActive: true,
          actionType: { in: [...CHANGED_ACTIONS] },
        },
        include: { levels: true },
      });
      for (const chain of chains) {
        const target = defaults.get(chain.actionType);
        if (!target || levelKey(chain.levels) === levelKey(target)) continue;
        const pending = await tx.approvalInstance.count({
          where: { chainId: chain.id, state: ApprovalState.pending },
        });
        console.log(
          `    ${chain.actionType}: ${chain.levels
            .sort((a, b) => a.position - b.position)
            .map((l) => l.label ?? l.slotKey)
            .join(' → ')}  ⇒  ${target
            .map((l) => l.label ?? l.slotKey)
            .join(' → ')}` +
            (pending ? `  (${pending} pending keep the old chain)` : ''),
        );
        if (!APPLY) continue;
        await tx.approvalChain.update({
          where: { id: chain.id },
          data: { isActive: false },
        });
        const created = await tx.approvalChain.create({
          data: {
            companyId: company.id,
            actionType: chain.actionType,
            isFinalAuthorityRequired: chain.isFinalAuthorityRequired,
            levels: {
              create: target.map((level) => ({
                companyId: company.id,
                position: level.position,
                slotKey: level.slotKey,
                isFinalAuthority: level.isFinalAuthority ?? false,
                label: level.label ?? null,
              })),
            },
          },
        });
        await tx.auditLogEntry.create({
          data: {
            entityType: AuditEntityType.APPROVAL_CHAIN_CONFIG,
            action: AuditAction.UPDATE,
            entityId: created.id,
            companyId: company.id,
            ipAddress: 'setup-client-roles',
            changes: {
              actionType: chain.actionType,
              levels: target.map((l) => ({
                position: l.position,
                slotKey: l.slotKey,
              })),
              supersededChain: { id: chain.id, levels: levelKey(chain.levels) },
              source: 'setup-client-roles (client roles sheet, 2026-11-07)',
            },
          },
        });
      }
    });
  }

  // ---------------------------------------------------------------- 4. roles and accounts that go
  const roles = await asSuperAdmin((tx) =>
    tx.role.findMany({
      select: {
        id: true,
        name: true,
        companyId: true,
        isProtected: true,
        isDefault: true,
        userRoles: { select: { userId: true } },
      },
    }),
  );
  const removed = rolesToRemove(roles);
  const removedIds = new Set(removed.map((r) => r.id));
  const keptRoleById = new Map(
    roles.filter((r) => !removedIds.has(r.id)).map((r) => [r.id, r] as const),
  );
  console.log(`\nRoles to remove: ${removed.length}`);
  for (const role of removed) {
    console.log(
      `  - ${role.name}${role.companyId ? ' (one company)' : ''}: ${
        role.userRoles.length
      } account(s)`,
    );
  }

  const affected = [
    ...new Set(removed.flatMap((r) => r.userRoles.map((u) => u.userId))),
  ];
  const users = await asSuperAdmin((tx) =>
    tx.user.findMany({
      where: { id: { in: affected } },
      select: {
        id: true,
        email: true,
        username: true,
        firstname: true,
        lastname: true,
        userRoles: { select: { roleId: true } },
        _count: {
          select: {
            auditLogEntries: true,
            approvalsRaised: true,
            approvalDecisions: true,
            approvalsDelegated: true,
          },
        },
      },
      orderBy: { email: 'asc' },
    }),
  );
  const plan = users.map((user) => {
    const keeps = user.userRoles
      .map((ur) => keptRoleById.get(ur.roleId))
      .filter((r): r is NonNullable<typeof r> => !!r && !r.isDefault);
    const history = Object.values(user._count).some((n) => n > 0);
    const action = keeps.length > 0 ? 'keep' : history ? 'retire' : 'delete';
    return { user, action, keeps: keeps.map((r) => r.name) };
  });
  console.log('\nAccounts:');
  for (const { user, action, keeps } of plan) {
    const name =
      [user.firstname, user.lastname].filter(Boolean).join(' ') || '—';
    const login = user.username
      ? `${user.username} / ${user.email}`
      : user.email;
    const detail =
      action === 'keep'
        ? `keep (still holds ${keeps.join(', ')}); loses the removed role`
        : action === 'retire'
        ? 'retire (has history): deactivated, login freed, name kept'
        : 'delete (no history)';
    console.log(`  ${name} <${login}>: ${detail}`);
  }
  const count = (a: string) => plan.filter((p) => p.action === a).length;
  console.log(
    `\n  ${count('delete')} to delete, ${count('retire')} to retire, ${count(
      'keep',
    )} kept with another role`,
  );

  if (!APPLY) return;

  for (const { user, action } of plan) {
    if (action === 'keep') continue;
    await asSuperAdmin(async (tx) => {
      const id = user.id;
      await tx.employee.updateMany({
        where: { userId: id },
        data: { userId: null },
      });
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.refreshToken.deleteMany({ where: { accountId: id } });
      await tx.inviteToken.deleteMany({ where: { userId: id } });
      await tx.passwordResetToken.deleteMany({ where: { userId: id } });
      await tx.userFaceUnlock.deleteMany({ where: { userId: id } });
      await tx.supervisorSite.deleteMany({ where: { userId: id } });
      await tx.userCompanySelection.deleteMany({ where: { userId: id } });
      if (action === 'retire') {
        await tx.user.update({
          where: { id },
          data: {
            status: UserStatus.deactivated,
            email: `removed+${id}@removed.invalid`,
            username: null,
            password: null,
          },
        });
      } else {
        await tx.notification.deleteMany({ where: { userId: id } });
        await tx.permissionRefusal.deleteMany({ where: { userId: id } });
        await tx.user.delete({ where: { id } });
      }
    });
  }
  await asSuperAdmin(async (tx) => {
    await tx.userRole.deleteMany({
      where: { roleId: { in: [...removedIds] } },
    });
    await tx.role.deleteMany({ where: { id: { in: [...removedIds] } } });
  });
  console.log('\nDone.');
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
