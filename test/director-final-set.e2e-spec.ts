import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalDecisionAction, Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { SLOT_FINAL } from '../src/approvals/approval-slots';
import { ApprovalService } from '../src/approvals/approvals.service';
import { ChainsService } from '../src/approvals/chains.service';
import {
  ACTION_DIRECTOR_FINAL_SET_CHANGE,
  ACTION_PAYMENT_RELEASE,
} from '../src/approvals/default-chains';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * The director-final set, as data and as a gate on itself (016 FR-018a to FR-018c).
 *
 * The claim that earns this suite: **whoever can edit the set could otherwise remove payment
 * release from it and then release a payment.** So the edit is itself director-final, and
 * this walks that through a real chain.
 *
 * Every fixture is prefixed `E2EDF` and removed in `afterAll`.
 */
const PREFIX = 'E2EDF';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(90_000);

describe('Director-final set (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvals: ApprovalService;
  let chains: ChainsService;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys: any = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_x, operation: string) => (args?: unknown) =>
              withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
                (tx as any)[model][operation](args),
              ),
          },
        ),
    },
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let companyId: string;
  let finalRoleId: string;
  let adminUserId: string;
  let directorUserId: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  const makeUser = async (label: string, roleId: string | null) => {
    const user = await sys.user.create({
      data: {
        email: `${unique(label)}@example.test`.toLowerCase(),
        username: unique(label),
        password: await hash('secret42'),
        displayName: `${PREFIX} ${label}`,
        companyId,
        status: 'active',
      },
    });
    userIds.push(user.id);
    if (roleId) {
      await sys.userRole.create({
        data: { userId: user.id, roleId, companyId },
      });
    }
    return user.id as string;
  };

  const asUser = (userId: string, roles: string[]) =>
    ({
      id: userId,
      userId,
      companyId,
      roleIds: roles,
      permissions: [Permission.COMPANY_SETTINGS],
      rls: { isSuperAdmin: false, companyId },
      ipAddress: '127.0.0.1',
    } as never);

  const eventually = async (
    check: () => Promise<boolean>,
    what: string,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for: ${what}`);
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    approvals = app.get(ApprovalService);
    chains = app.get(ChainsService);

    const company = await sys.company.create({
      data: {
        name: `${PREFIX} Director Constructions`,
        shortCode: unique('D').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    const role = await sys.role.create({
      data: {
        name: unique('Director'),
        permissions: [Permission.COMPANY_SETTINGS],
      },
    });
    roleIds.push(role.id);
    finalRoleId = role.id;

    adminUserId = await makeUser('Admin', null);
    directorUserId = await makeUser('Director', finalRoleId);

    const ctx = { isSuperAdmin: false, companyId };
    const actor = { userId: adminUserId, ipAddress: '127.0.0.1' };
    await chains.putSlotMapping(
      ctx,
      { companyId, slotKey: SLOT_FINAL, roleId: finalRoleId },
      actor,
    );
    await chains.upsertChain(
      ctx,
      {
        companyId,
        actionType: ACTION_DIRECTOR_FINAL_SET_CHANGE,
        levels: [{ position: 1, slotKey: SLOT_FINAL, isFinalAuthority: true }],
      },
      actor,
    );
    // A company created after the seeding migration needs its own rows, which is what
    // `seedDefaultsForCompany` does for chains. Seeded here so the set has something in it.
    await sys.directorFinalAction.create({
      data: {
        companyId,
        actionType: ACTION_PAYMENT_RELEASE,
        isFinal: true,
        updatedAt: new Date(),
      },
    });
  }, 90_000);

  // Releases the database pool. Added 2026-10-04: 19 of the 33 e2e suites never closed
  // their app, and `app.close()` alone was not enough either — `PrismaService` has no
  // `onModuleDestroy`, so `PrismaShutdownService` had to be added to make closing work.
  // Together these are why the suites could not all run in one go: Postgres refused new
  // connections part-way through, 158 failures with no product defect behind any of them.
  afterAll(async () => {
    await app.close();
  });

  afterAll(async () => {
    await sys.directorFinalChangeProposal.deleteMany({ where: { companyId } });
    await sys.directorFinalAction.deleteMany({ where: { companyId } });
    await sys.approvalDecision.deleteMany({ where: { companyId } });
    await sys.approvalInstance.deleteMany({ where: { companyId } });
    await sys.approvalLevel.deleteMany({ where: { companyId } });
    await sys.approvalChain.deleteMany({ where: { companyId } });
    await sys.roleSlotMapping.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app?.close();
  });

  it('reports three states, not two (FR-018c)', async () => {
    const set = await approvals.directorFinalSet(companyId);
    const byType = new Map(set.map((e) => [e.actionType, e]));

    // Stored and true.
    expect(byType.get(ACTION_PAYMENT_RELEASE)?.state).toBe('final');
    // Seeded by configuration, no stored row — still a decision this product made.
    expect(byType.get('payroll_run')?.state).toBe('final');
    // Configured as a chain here but named by nothing as director-final. This is the third
    // state, and the reason the requirement exists: collapsing it into "not final" would hide
    // exactly the gap the client is asking about.
    expect(set.some((e) => e.state === 'not_configured')).toBe(true);
  });

  it('a proposed change does not take effect while it is pending', async () => {
    const { instanceId } = await approvals.submitDirectorFinalChange(
      companyId,
      [{ actionType: ACTION_PAYMENT_RELEASE, isFinal: false }],
      asUser(adminUserId, []),
    );
    expect(instanceId).toBeTruthy();

    // Still gated. This is the assertion that matters: if the edit took effect on
    // submission, whoever could edit could release a payment.
    expect(
      await approvals.isDirectorFinal(companyId, ACTION_PAYMENT_RELEASE),
    ).toBe(true);

    const pending = await approvals.pendingDirectorFinalChange(companyId);
    expect(pending?.instanceId).toBe(instanceId);
    // The before is captured at submission, so the record says what the set looked like when
    // somebody decided to change it.
    expect(
      (pending?.before as Record<string, boolean>)[ACTION_PAYMENT_RELEASE],
    ).toBe(true);
    expect(
      (pending?.after as Record<string, boolean>)[ACTION_PAYMENT_RELEASE],
    ).toBe(false);
  });

  it('takes effect once the Director approves, and records who', async () => {
    const pending = await approvals.pendingDirectorFinalChange(companyId);
    await approvals.decide(
      {
        instanceId: String(pending?.instanceId),
        action: ApprovalDecisionAction.approve,
      },
      asUser(directorUserId, [finalRoleId]),
      '127.0.0.1',
    );

    await eventually(
      async () =>
        (await approvals.isDirectorFinal(companyId, ACTION_PAYMENT_RELEASE)) ===
        false,
      'the approved change to take effect',
    );

    const set = await approvals.directorFinalSet(companyId);
    const entry = set.find((e) => e.actionType === ACTION_PAYMENT_RELEASE);
    // Un-gated by an explicit decision, which is a different fact from never configured.
    expect(entry?.state).toBe('not_final_by_decision');
    expect(entry?.updatedBy).toBe(adminUserId);
  });

  it('refuses an attempt to change the gate on changing the set', async () => {
    // If this were possible it would be the first thing anybody bypassing approval did.
    await expect(
      approvals.submitDirectorFinalChange(
        companyId,
        [{ actionType: ACTION_DIRECTOR_FINAL_SET_CHANGE, isFinal: false }],
        asUser(adminUserId, []),
      ),
    ).rejects.toMatchObject({
      response: { code: 'DIRECTOR_FINAL_SELF_CHANGE_REFUSED' },
    });
  });

  it('applying the same completion twice writes once', async () => {
    const proposals = await sys.directorFinalChangeProposal.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    const before = await approvals.isDirectorFinal(
      companyId,
      ACTION_PAYMENT_RELEASE,
    );

    await approvals.onDirectorFinalChangeCompleted({
      entityType: ACTION_DIRECTOR_FINAL_SET_CHANGE,
      entityId: companyId,
      companyId,
      instanceId: proposals[0].approvalInstanceId,
    });

    expect(
      await approvals.isDirectorFinal(companyId, ACTION_PAYMENT_RELEASE),
    ).toBe(before);
  });

  it('a stored false is not overridden by the config default', async () => {
    // `payroll_run` is in the config list. A company that deliberately un-gated it must not
    // have that decision quietly reversed by the fallback.
    await sys.directorFinalAction.create({
      data: {
        companyId,
        actionType: 'payroll_run',
        isFinal: false,
        updatedAt: new Date(),
      },
    });
    expect(await approvals.isDirectorFinal(companyId, 'payroll_run')).toBe(
      false,
    );
  });
});
