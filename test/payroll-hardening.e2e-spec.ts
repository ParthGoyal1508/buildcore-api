import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalDecisionAction, Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { SLOT_FIRST_APPROVER, SLOT_HR } from '../src/approvals/approval-slots';
import { ApprovalService } from '../src/approvals/approvals.service';
import { ChainsService } from '../src/approvals/chains.service';
import { ACTION_PAYROLL_RUN } from '../src/approvals/default-chains';
import type { AuthenticatedUser } from '../src/auth/authenticated-user';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * 036 stream 1a (payroll) — the server rules, end to end.
 *
 *   * F1/F3: generating and regenerating a draft leaves the advance balance alone; processing takes
 *     it once and the payslip shows it.
 *   * F6: two "process" requests at once settle once; `processed → paid` waits for approval.
 *   * 039: processing waits for the Director, whom HR sends the draft to.
 *   * F7/F8: run detail carries its exceptions and each line's server gross and deductions.
 *   * F11: the bank sheet generates by POST; history pages with `X-Total-Count`.
 *   * F19: the maker of an advance or loan cannot approve it.
 *
 * Every fixture is prefixed `E2EPH` and removed in `afterAll`, scoped to the company it created.
 */
const PREFIX = 'E2EPH';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

/** Last month in the business timezone — the period a run would normally be drawn for. */
function lastPeriod(): string {
  const [year, month] = new Date()
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    .split('-')
    .map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return `${previous.getUTCFullYear()}-${String(
    previous.getUTCMonth() + 1,
  ).padStart(2, '0')}`;
}

describe('Payroll hardening (036 stream 1a, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;

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
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let companyId: string;
  let siteId: string;
  let shiftId: string;
  let employeeId: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const period = lastPeriod();

  let maker: { userId: string; token: string };
  let checker: { userId: string; token: string };
  let advanceId: string;
  let runId: string;
  /** The role the payroll chain's one level (Director, the final slot) resolves to. */
  let directorRoleId: string;

  const makeUser = async (label: string, permissions: Permission[]) => {
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
    const role = await sys.role.create({
      data: { name: unique(`${label}Access`), permissions },
    });
    roleIds.push(role.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return { userId: user.id, token: login.body.accessToken };
  };

  const advanceRow = () =>
    sys.salaryAdvance.findUnique({ where: { id: advanceId } });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const company = await sys.company.create({
      data: {
        name: 'Dummy Payroll Hardening Test Firm',
        shortCode: unique('PH').slice(0, 10),
        payrollLockDay: 31,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 0,
        bonusRate: 0,
        payrollDebitAccountNumber: '00112233445566',
      },
    });
    companyId = company.id;
    siteId = (
      await sys.site.create({
        data: {
          companyId,
          name: unique('Site'),
          latitude: 18.5204,
          longitude: 73.8567,
          geofenceRadiusMeters: 200,
          weeklyOffDay: 0,
        },
      })
    ).id;
    shiftId = (
      await sys.shift.create({
        data: {
          companyId,
          name: unique('Shift'),
          inTime: new Date('1970-01-01T09:00:00Z'),
          outTime: new Date('1970-01-01T18:00:00Z'),
        },
      })
    ).id;
    employeeId = (
      await sys.employee.create({
        data: {
          companyId,
          siteId,
          shiftId,
          employeeCode: unique('E').slice(0, 20),
          firstName: 'Dummy',
          lastName: 'Employee',
          dateOfJoining: new Date('2026-01-01'),
          basic: 30000,
          hra: 12000,
          conveyanceAllowance: 1600,
        },
      })
    ).id;

    // A chain, so processing submits the run and "paid" has an approval to wait for. Three roles,
    // because one role on two levels is refused as unsatisfiable.
    const chainRole: Record<string, string> = {};
    for (const label of ['Site', 'Hr', 'Final']) {
      const role = await sys.role.create({
        data: { name: unique(`Chain${label}`), permissions: [] },
      });
      roleIds.push(role.id);
      chainRole[label] = role.id;
    }
    await withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
      app.get(ChainsService).seedDefaultsForCompany(companyId, tx, {
        superAdminRoleId: chainRole.Final,
      }),
    );

    maker = await makeUser('Maker', [Permission.PAYROLL, Permission.LOANS]);
    checker = await makeUser('Checker', [Permission.PAYROLL, Permission.LOANS]);
    // 039: the checker also approves payroll as the Director.
    directorRoleId = chainRole.Final;
    await sys.userRole.create({
      data: { userId: checker.userId, roleId: directorRoleId, companyId },
    });
    const actor = { userId: maker.userId, ipAddress: '127.0.0.1' };
    const ctx = { isSuperAdmin: false, companyId };
    await app
      .get(ChainsService)
      .putSlotMapping(
        ctx,
        { companyId, slotKey: SLOT_FIRST_APPROVER, roleId: chainRole.Site },
        actor,
      );
    await app
      .get(ChainsService)
      .putSlotMapping(
        ctx,
        { companyId, slotKey: SLOT_HR, roleId: chainRole.Hr },
        actor,
      );
  }, 90_000);

  afterAll(async () => {
    await sys.approvalDecision.deleteMany({ where: { companyId } });
    await sys.approvalInstance.deleteMany({ where: { companyId } });
    await sys.approvalLevel.deleteMany({ where: { companyId } });
    await sys.approvalChain.deleteMany({ where: { companyId } });
    await sys.roleSlotMapping.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    await sys.salarySlip.deleteMany({ where: { employeeId } });
    await sys.payrollLineItem.deleteMany({
      where: { payrollRun: { companyId } },
    });
    await sys.bankSheetExport.deleteMany({ where: { companyId } });
    await sys.payrollRun.deleteMany({ where: { companyId } });
    await sys.salaryAdvance.deleteMany({ where: { employeeId } });
    await sys.loan.deleteMany({ where: { companyId } });
    await sys.employee.deleteMany({ where: { companyId } });
    await sys.refreshToken.deleteMany({ where: { companyId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.shift.deleteMany({ where: { id: shiftId } });
    await sys.site.deleteMany({ where: { id: siteId } });
    await sys.company.deleteMany({ where: { id: companyId } });
    await app.close();
  }, 90_000);

  describe('F19 — maker-checker', () => {
    it('refuses the maker of an advance, then lets someone else approve it', async () => {
      const created = await http()
        .post('/hr/salary-advances')
        .set(auth(maker.token))
        .send({
          employeeId,
          amount: 1000,
          reason: 'Dummy advance',
          recoveryMonth: period,
        })
        .expect(201);
      advanceId = created.body.id;
      expect(created.body.createdByUserId).toBe(maker.userId);

      const refused = await http()
        .patch(`/hr/salary-advances/${advanceId}/approve`)
        .set(auth(maker.token))
        .expect(403);
      expect(refused.body.code).toBe('SELF_APPROVAL');

      await http()
        .patch(`/hr/salary-advances/${advanceId}/approve`)
        .set(auth(checker.token))
        .expect(200);
      expect((await advanceRow()).status).toBe('disbursed');
    });

    it('refuses an advance above the cap', async () => {
      await http()
        .post('/hr/salary-advances')
        .set(auth(maker.token))
        .send({
          employeeId,
          amount: 5_000_000,
          reason: 'Dummy',
          recoveryMonth: period,
        })
        .expect(400);
    });

    it('refuses the maker of a loan', async () => {
      const loan = await http()
        .post('/hr/loans')
        .set(auth(maker.token))
        .send({
          employeeId,
          amount: 12000,
          emiAmount: 1000,
          disbursementDate: '2030-01-15',
          reason: 'Dummy loan',
        })
        .expect(201);
      const refused = await http()
        .patch(`/hr/loans/${loan.body.id}/approve`)
        .set(auth(maker.token))
        .expect(403);
      expect(refused.body.code).toBe('SELF_APPROVAL');
    });
  });

  describe('F1/F3/F6/F7/F8 — the run lifecycle', () => {
    it('generating a draft records the recovery but leaves the balance', async () => {
      const res = await http()
        .post('/hr/payroll/runs')
        .set(auth(maker.token))
        .send({ period })
        .expect(201);
      runId = res.body.runId;

      const line = await sys.payrollLineItem.findFirst({
        where: { payrollRunId: runId, employeeId },
      });
      // Vacuity guard: a line that recovered nothing proves nothing about recovering twice.
      expect(Number(line.advanceRecovered)).toBeGreaterThan(0);
      expect(line.advanceRecoveryAdvanceId).toBe(advanceId);
      expect(Number((await advanceRow()).outstandingBalance)).toBe(1000);
    });

    it('regenerating twice still leaves the balance (the F1 bug)', async () => {
      for (let i = 0; i < 2; i += 1) {
        await http()
          .post('/hr/payroll/runs')
          .set(auth(maker.token))
          .send({ period })
          .expect(201);
      }
      const advance = await advanceRow();
      expect(Number(advance.outstandingBalance)).toBe(1000);
      expect(advance.status).toBe('disbursed');
    });

    it('run detail carries exceptions and server totals per line', async () => {
      const res = await http()
        .get(`/hr/payroll/runs/${runId}`)
        .set(auth(maker.token))
        .expect(200);
      expect(Array.isArray(res.body.exceptions)).toBe(true);
      const line = res.body.lineItems.find(
        (l: { employeeId: string }) => l.employeeId === employeeId,
      );
      expect(line.gross).toBeDefined();
      expect(line.totalDeductions).toBeDefined();
      expect(Number(line.advanceRecovered)).toBeGreaterThan(0);
      if (Number(line.netPay) > 0) {
        expect(
          Math.round((Number(line.gross) - Number(line.totalDeductions)) * 100),
        ).toBe(Math.round(Number(line.netPay) * 100));
      }
    });

    it('039 — processing waits for the Director, whom HR sends the draft to', async () => {
      const unsent = await http()
        .patch(`/hr/payroll/runs/${runId}/status`)
        .set(auth(maker.token))
        .send({ status: 'processed' })
        .expect(409);
      expect(unsent.body.code).toBe('PAYROLL_RUN_NOT_SUBMITTED');

      await http()
        .post(`/hr/payroll/runs/${runId}/submit-for-approval`)
        .set(auth(maker.token))
        .expect(201);
      const pending = await http()
        .patch(`/hr/payroll/runs/${runId}/status`)
        .set(auth(maker.token))
        .send({ status: 'processed' })
        .expect(409);
      expect(pending.body.code).toBe('PAYROLL_RUN_NOT_APPROVED');

      const approvals = app.get(ApprovalService);
      const state = await approvals.stateOfSystem(
        ACTION_PAYROLL_RUN,
        runId,
        companyId,
      );
      await approvals.decide(
        {
          instanceId: state.instanceId,
          action: ApprovalDecisionAction.approve,
        },
        {
          id: checker.userId,
          companyId,
          roleIds: [directorRoleId],
          permissions: [],
          grants: [],
        } as unknown as AuthenticatedUser,
        '127.0.0.1',
      );
    });

    it('two simultaneous process requests settle once', async () => {
      const results = await Promise.all(
        [0, 1].map(() =>
          http()
            .patch(`/hr/payroll/runs/${runId}/status`)
            .set(auth(maker.token))
            .send({ status: 'processed' }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

      const line = await sys.payrollLineItem.findFirst({
        where: { payrollRunId: runId, employeeId },
      });
      const advance = await advanceRow();
      expect(Number(advance.outstandingBalance)).toBeCloseTo(
        1000 - Number(line.advanceRecovered),
        2,
      );
      const run = await sys.payrollRun.findUnique({ where: { id: runId } });
      expect(run.recoveriesSettledAt).not.toBeNull();
    });

    it('the payslip shows the advance recovered (F3)', async () => {
      const line = await sys.payrollLineItem.findFirst({
        where: { payrollRunId: runId, employeeId },
      });
      const slip = await sys.salarySlip.findFirst({
        where: { employeeId, period },
      });
      expect(Number(slip.deductionAdvanceRecovery)).toBe(
        Number(line.advanceRecovered),
      );
    });

    it('refuses processed → paid while the approval is pending (F6)', async () => {
      // A run processed before 039, approval sent afterwards and still pending. A run processed
      // since 039 was approved first, so this is the case the gate is still for.
      const legacy = await sys.payrollRun.create({
        data: { companyId, period: '2019-03', status: 'processed' },
      });
      await http()
        .post(`/hr/payroll/runs/${legacy.id}/submit-for-approval`)
        .set(auth(maker.token))
        .expect(201);
      const res = await http()
        .patch(`/hr/payroll/runs/${legacy.id}/status`)
        .set(auth(maker.token))
        .send({ status: 'paid' })
        .expect(409);
      expect(res.body.code).toBe('PAYROLL_RUN_NOT_APPROVED');
    });

    it('refuses to regenerate a processed run', async () => {
      await http()
        .post('/hr/payroll/runs')
        .set(auth(maker.token))
        .send({ period })
        .expect(409);
    });

    it('refuses to discard a processed run, and discards a draft (036 F9)', async () => {
      const refused = await http()
        .delete(`/hr/payroll/runs/${runId}`)
        .set(auth(maker.token))
        .expect(409);
      expect(refused.body.code).toBe('PAYROLL_RUN_NOT_DRAFT');

      // A draft for the month before, generated by mistake.
      const [y, m] = period.split('-').map(Number);
      const earlier =
        m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
      const draft = await http()
        .post('/hr/payroll/runs')
        .set(auth(maker.token))
        .send({ period: earlier })
        .expect(201);
      await http()
        .delete(`/hr/payroll/runs/${draft.body.runId}`)
        .set(auth(maker.token))
        .expect(204);
      expect(
        await sys.payrollRun.findUnique({ where: { id: draft.body.runId } }),
      ).toBeNull();
    });
  });

  describe('F11 — bank sheet', () => {
    it('generates by POST, gated on approval like the GET', async () => {
      // The run above is approved and processed; this one is processed and still with the Director.
      const [y, m] = period.split('-').map(Number);
      const earlier =
        m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
      const legacy = await sys.payrollRun.create({
        data: { companyId, period: earlier, status: 'processed' },
      });
      await http()
        .post(`/hr/payroll/runs/${legacy.id}/submit-for-approval`)
        .set(auth(maker.token))
        .expect(201);

      const post = await http()
        .post(`/hr/payroll/runs/${legacy.id}/bank-sheet`)
        .set(auth(maker.token))
        .expect(409);
      expect(post.body.code).toBe('PAYROLL_RUN_NOT_APPROVED');

      const [year, month] = earlier.split('-').map(Number);
      const byMonth = await http()
        .post('/hr/payroll/bank-sheet')
        .set(auth(maker.token))
        .send({ year, month })
        .expect(409);
      expect(byMonth.body.code).toBe('PAYROLL_RUN_NOT_APPROVED');
      const preview = await http()
        .get('/hr/payroll/bank-sheet/preview')
        .query({ year, month })
        .set(auth(maker.token))
        .expect(409);
      expect(preview.body.code).toBe('PAYROLL_RUN_NOT_APPROVED');
    });

    it('pages the history and reports the total in X-Total-Count', async () => {
      const [year, month] = period.split('-').map(Number);
      const res = await http()
        .get('/hr/payroll/bank-sheet/history')
        .query({ year, month, page: 1, pageSize: 5 })
        .set(auth(maker.token))
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.headers['x-total-count']).toBe('0');
    });
  });
});
