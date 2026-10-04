import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ApprovalDecisionAction,
  OperatorRecoveryStatus,
  Permission,
} from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { SLOT_FIRST_APPROVER, SLOT_HR } from '../src/approvals/approval-slots';
import { ApprovalService } from '../src/approvals/approvals.service';
import { ChainsService } from '../src/approvals/chains.service';
import { AuthenticatedUser } from '../src/auth/authenticated-user';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { FuelRecoveryService } from '../src/plant/fuel-recovery/fuel-recovery.service';

/**
 * An operator fuel recovery reaches payroll only through an approval (020 FR-006, T064 and T065).
 *
 * ## Why these two stayed open
 *
 * Both were recorded `NOT RUN`, and the reason was the harness rather than the feature: running the
 * 33 end-to-end suites together exhausted the database's connections, so suites were not being
 * added to a run that could not finish. That was fixed on 2026-10-04 and these are the first two
 * written against it.
 *
 * ## What only a database can show here
 *
 * The gate is one `where` clause — `FuelRecoveryService.dueForEmployees` selects
 * `status: approved` — and that is exactly why it is worth an end-to-end test rather than a unit
 * one. A unit test asserts the clause is written. It cannot assert that the **status actually
 * changes when the chain completes**, which is the half that involves three approvers, an event
 * emitted by the spine, and a handler in another module. A recovery stuck at `pending_approval`
 * because the handler never fired would satisfy every unit test in the feature while quietly
 * never being collected; a recovery marked `approved` by a path that skipped the chain would
 * satisfy them too, while docking an operator's wages nobody authorised.
 *
 * So the assertion is not "pending is excluded". It is **the same recovery, read twice**: invisible
 * to payroll before the chain completes and visible after, with nothing else changed.
 *
 * T065's case is the one with the sharper edge. A rejection must leave the recovery permanently
 * outside payroll's reach — and the failure to guard against is not an error, it is a rejected
 * recovery that is collected anyway, which looks like success to everyone except the operator whose
 * wages were docked by a decision that went against it.
 *
 * Fixtures are prefixed `E2EFR` and removed in `afterAll`.
 */
const PREFIX = 'E2EFR';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;

/** Benchmark 10 L per hour × 8 hours = 80 L allowed; 100 L burned; ₹95 a litre. */
const BENCHMARK_LITRES_PER_HOUR = 10;
const HOURS_RUN = 8;
const LITRES_BURNED = 100;
const RATE_PER_LITRE = 95;
/** 20 litres over, at ₹95 — the figure every assertion below is measured against. */
const EXPECTED_SHORTFALL = 1900;

describe('Operator fuel recovery through the approval chain (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let approvals: ApprovalService;
  let chains: ChainsService;
  let recoveries: FuelRecoveryService;
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
  let categoryId: string;
  let equipmentId: string;
  let operatorEmployeeId: string;

  let reviewerToken = '';
  let siteRoleId = '';
  let hrRoleId = '';
  let finalRoleId = '';
  let siteUserId = '';
  let hrUserId = '';
  let directorUserId = '';

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const exceptionIds: string[] = [];
  let rejectedExceptionId = '';

  const asUser = (id: string, holds: string[]): AuthenticatedUser =>
    ({
      id,
      companyId,
      permissions: [],
      roleNames: [],
      roleIds: holds,
      displayName: null,
      firstname: 'E2E',
      lastname: 'Approver',
      username: id,
      email: `${id}@example.test`,
      status: 'active',
    } as unknown as AuthenticatedUser);

  /** An account holding one chain role, plus the permissions the fuel routes need. */
  const makeActor = async (label: string, chainRoleId?: string) => {
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

    const accessRole = await sys.role.create({
      data: {
        name: unique(`${label}Access`),
        permissions: [Permission.FUEL, Permission.MACHINERY],
      },
    });
    roleIds.push(accessRole.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: accessRole.id, companyId },
    });
    if (chainRoleId) {
      await sys.userRole.create({
        data: { userId: user.id, roleId: chainRoleId, companyId },
      });
    }

    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return { userId: user.id, token: login.body.accessToken };
  };

  /**
   * A confirmed exception attributed to the operator, with the readings that make it recoverable.
   *
   * Written directly rather than driven through a month of logbook entries: what is under test is
   * what happens to a recovery **after** it is raised, and the detection half — the variance
   * calculation and the alert — is covered by `fuel.service.spec.ts` and is deliberately unchanged
   * by this feature.
   */
  const confirmedException = async (
    dayOffset: number,
    attribution: 'operator' | 'both' = 'operator',
  ) => {
    const date = new Date(Date.UTC(2026, 7, 10 + dayOffset));
    const fuelEntry = await sys.fuelEntry.create({
      data: {
        companyId,
        equipmentId,
        date,
        quantity: LITRES_BURNED,
        rate: RATE_PER_LITRE,
        amount: LITRES_BURNED * RATE_PER_LITRE,
        varianceAlert: true,
      },
    });
    await sys.logbookEntry.create({
      data: {
        companyId,
        equipmentId,
        date,
        openingReading: 1000 + dayOffset * 10,
        closingReading: 1000 + dayOffset * 10 + HOURS_RUN,
        totalHours: HOURS_RUN,
        fuelConsumed: LITRES_BURNED,
      },
    });
    const exception = await sys.fuelVarianceException.create({
      data: {
        companyId,
        fuelEntryId: fuelEntry.id,
        status: 'confirmed',
        attribution,
        operatorEmployeeId,
        reviewedAt: new Date(),
      },
    });
    exceptionIds.push(exception.id);
    return exception.id;
  };

  /** What payroll sees. The gate under test is inside this call, not around it. */
  const payrollSees = async () =>
    (await recoveries.dueForEmployees(companyId, [operatorEmployeeId])).get(
      operatorEmployeeId,
    ) ?? [];

  /** Walks a three-level chain with three different people, as FR-021a requires. */
  const walkChain = async (
    instanceId: string,
    action: ApprovalDecisionAction,
    rejectAt: 1 | 2 | 3 | null = null,
  ) => {
    const levels: [string, string][] = [
      [siteUserId, siteRoleId],
      [hrUserId, hrRoleId],
      [directorUserId, finalRoleId],
    ];
    let last;
    for (const [index, [userId, roleId]] of levels.entries()) {
      const position = (index + 1) as 1 | 2 | 3;
      const decision =
        rejectAt === position ? ApprovalDecisionAction.reject : action;
      last = await approvals.decide(
        {
          instanceId,
          action: decision,
          reason:
            decision === ApprovalDecisionAction.reject
              ? 'E2E: the reading was corrected after the fact'
              : null,
        },
        asUser(userId, [roleId]),
        '127.0.0.1',
      );
      if (decision === ApprovalDecisionAction.reject) break;
    }
    return last;
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
    recoveries = app.get(FuelRecoveryService);
    http = () => request(app.getHttpServer());

    const company = await sys.company.create({
      data: {
        name: `${PREFIX} Fuel Recovery Co`,
        shortCode: unique('FR').slice(0, 10),
        payrollLockDay: 31,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });
    companyId = company.id;

    const category = await sys.equipmentCategory.create({
      data: {
        companyId,
        name: unique('EXCAV').toUpperCase(),
        meterType: 'hours',
        fuelBenchmark: BENCHMARK_LITRES_PER_HOUR,
        fuelVarianceThresholdPercent: 10,
      },
    });
    categoryId = category.id;

    const equipment = await sys.equipment.create({
      data: {
        companyId,
        categoryId,
        code: unique('EQ').slice(0, 20),
        name: `${PREFIX} JCB`,
        ownership: 'owned',
        powerSource: 'diesel',
        meterType: 'hours',
      },
    });
    equipmentId = equipment.id;

    // The operator needs an account of their own: `Employee.userId` is required, and the recovery
    // is ultimately a deduction from this person's wages.
    const operatorSite = await sys.site.create({
      data: {
        companyId,
        name: unique('Yard'),
        latitude: 18.5204,
        longitude: 73.8567,
        geofenceRadiusMeters: 200,
        weeklyOffDay: 0,
      },
    });
    const shift = await sys.shift.create({
      data: {
        companyId,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00Z'),
        outTime: new Date('1970-01-01T18:00:00Z'),
      },
    });
    const operatorAccount = await makeActor('Operator');
    const operator = await sys.employee.create({
      data: {
        userId: operatorAccount.userId,
        companyId,
        siteId: operatorSite.id,
        shiftId: shift.id,
        employeeCode: unique('OP').slice(0, 20),
        firstName: 'E2E',
        lastName: 'Operator',
        dateOfJoining: new Date(Date.UTC(2025, 0, 1)),
      },
    });
    operatorEmployeeId = operator.id;

    // Three chain roles, then the chain itself — the same arrangement a newly created company
    // receives, built explicitly here so the test does not depend on which roles happen to exist.
    siteRoleId = (
      await sys.role.create({
        data: { name: unique('SiteSlot'), permissions: [] },
      })
    ).id;
    hrRoleId = (
      await sys.role.create({
        data: { name: unique('HrSlot'), permissions: [] },
      })
    ).id;
    finalRoleId = (
      await sys.role.create({
        data: { name: unique('FinalSlot'), permissions: [] },
      })
    ).id;
    roleIds.push(siteRoleId, hrRoleId, finalRoleId);

    const setup = await makeActor('Setup');
    const ctx = { isSuperAdmin: false, companyId };
    const actor = { userId: setup.userId, ipAddress: '127.0.0.1' };

    await withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
      chains.seedDefaultsForCompany(companyId, tx, {
        superAdminRoleId: finalRoleId,
      }),
    );
    await chains.putSlotMapping(
      ctx,
      { companyId, slotKey: SLOT_FIRST_APPROVER, roleId: siteRoleId },
      actor,
    );
    await chains.putSlotMapping(
      ctx,
      { companyId, slotKey: SLOT_HR, roleId: hrRoleId },
      actor,
    );

    const site = await makeActor('SiteApprover', siteRoleId);
    siteUserId = site.userId;
    const hr = await makeActor('HrApprover', hrRoleId);
    hrUserId = hr.userId;
    const director = await makeActor('Director', finalRoleId);
    directorUserId = director.userId;

    // The reviewer who raises recoveries holds FUEL and MACHINERY and no chain role — raising is
    // not deciding, and an account that could do both would hide an authorisation hole.
    reviewerToken = (await makeActor('Reviewer')).token;
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  afterAll(async () => {
    await sys.approvalDecision.deleteMany({ where: { companyId } });
    await sys.approvalInstance.deleteMany({ where: { companyId } });
    await sys.approvalLevel.deleteMany({ where: { companyId } });
    await sys.approvalChain.deleteMany({ where: { companyId } });
    await sys.roleSlotMapping.deleteMany({ where: { companyId } });
    await sys.operatorFuelRecovery.deleteMany({ where: { companyId } });
    for (const id of exceptionIds) {
      await sys.fuelVarianceException.deleteMany({ where: { id } });
    }
    await sys.logbookEntry.deleteMany({ where: { companyId } });
    await sys.site.deleteMany({ where: { companyId } });
    await sys.shift.deleteMany({ where: { companyId } });
    await sys.fuelEntry.deleteMany({ where: { companyId } });
    await sys.equipment.deleteMany({ where: { companyId } });
    await sys.equipmentCategory.deleteMany({ where: { companyId } });
    await sys.employee.deleteMany({ where: { companyId } });
    await sys.auditLogEntry.deleteMany({ where: { companyId } });
    for (const id of userIds) {
      await sys.userRole.deleteMany({ where: { userId: id } });
      await sys.refreshToken.deleteMany({ where: { accountId: id } });
      await sys.auditLogEntry.updateMany({
        where: { accountId: id },
        data: { accountId: null },
      });
      await sys.user.deleteMany({ where: { id } });
    }
    // Roles last, and only the ones this suite created — a role still held by a user is a foreign
    // key error that would mask whatever actually failed.
    for (const id of roleIds) {
      await sys.rolePermission.deleteMany({ where: { roleId: id } });
      await sys.role.deleteMany({ where: { id } });
    }
    await sys.company.deleteMany({ where: { id: companyId } });
  }, 120_000);

  describe('T064 — a recovery reaches payroll only once the chain completes', () => {
    it('is invisible to payroll while the approval is pending', async () => {
      // Not vacuous: asserted before anything is raised, so the "nothing due" below cannot be the
      // answer to an empty company.
      expect(await payrollSees()).toEqual([]);

      const exceptionId = await confirmedException(0);
      const raised = await http()
        .post(`/plant/fuel-exceptions/${exceptionId}/recover/operator`)
        .set(auth(reviewerToken))
        .send({})
        .expect(201);

      // The row exists, it is for the right money, and it is for the right person.
      const row = await sys.operatorFuelRecovery.findFirst({
        where: { fuelVarianceExceptionId: exceptionId },
      });
      expect(row).not.toBeNull();
      expect(row.status).toBe(OperatorRecoveryStatus.pending_approval);
      expect(Number(row.amount)).toBeCloseTo(EXPECTED_SHORTFALL, 2);
      expect(row.employeeId).toBe(operatorEmployeeId);
      expect(row.approvalItemId).not.toBeNull();
      // The response's own account of itself, including the figure. 20 litres over benchmark at
      // ₹95 — asserted here as well as on the row, because the reviewer decides from the response
      // and a response that disagreed with the row would be the defect worth catching.
      expect(raised.body.state).toBe('pending');
      expect(raised.body.recoveryId).toBe(row.id);
      expect(raised.body.shortfall).toEqual({
        shortfallQuantity: 20,
        shortfallAmount: EXPECTED_SHORTFALL,
      });

      // **The assertion that matters.** The money is owed, recorded and visible to a reviewer —
      // and payroll cannot see it, because FR-006 says nothing reaches a payroll line without an
      // approval. A recovery that leaked through here would dock wages nobody authorised.
      expect(await payrollSees()).toEqual([]);
    });

    it('appears to payroll, once, after all three levels approve', async () => {
      const row = await sys.operatorFuelRecovery.findFirst({
        where: { employeeId: operatorEmployeeId },
      });

      const completed = await walkChain(
        row.approvalItemId,
        ApprovalDecisionAction.approve,
      );
      expect(completed?.state).toBe('approved');

      // The same recovery, read again. Nothing about it changed except that a chain completed.
      const due = await payrollSees();
      expect(due).toHaveLength(1);
      expect(due[0].recoveryId).toBe(row.id);
      expect(due[0].balance).toBeCloseTo(EXPECTED_SHORTFALL, 2);

      // The status moved because the spine's event reached this module's handler — the half a unit
      // test cannot reach, and the half that would fail silently if the wiring were dropped.
      const after = await sys.operatorFuelRecovery.findUnique({
        where: { id: row.id },
      });
      expect(after.status).toBe(OperatorRecoveryStatus.approved);
    });

    it('is named on the deduction, not presented as an unexplained figure', async () => {
      // FR-007a: the payroll line must say what it is. A deduction an operator cannot account for
      // is one they will dispute, and the dispute is the cost the client accepted this feature for.
      const due = await payrollSees();
      const recovery = await sys.operatorFuelRecovery.findUnique({
        where: { id: due[0].recoveryId },
        include: { fuelVarianceException: { include: { fuelEntry: true } } },
      });
      expect(recovery.fuelVarianceException.operatorEmployeeId).toBe(
        operatorEmployeeId,
      );
      // Traceable all the way back to the reading it came from — the date, the machine, the litres.
      expect(recovery.fuelVarianceException.fuelEntry.equipmentId).toBe(
        equipmentId,
      );
      expect(Number(recovery.fuelVarianceException.fuelEntry.quantity)).toBe(
        LITRES_BURNED,
      );
    });
  });

  describe('T065 — a rejected recovery never touches a payroll line', () => {
    it('leaves nothing for payroll to collect, at any level of rejection', async () => {
      const before = await payrollSees();

      // Attributed to **both**, so the only thing that could block a hire-bill recovery later is
      // the rejected operator recovery itself. See the next test.
      const exceptionId = await confirmedException(5, 'both');
      rejectedExceptionId = exceptionId;
      await http()
        .post(`/plant/fuel-exceptions/${exceptionId}/recover/operator`)
        .set(auth(reviewerToken))
        .send({})
        .expect(201);
      const row = await sys.operatorFuelRecovery.findFirst({
        where: { fuelVarianceExceptionId: exceptionId },
      });

      // Rejected at the middle level, deliberately. A rejection at the first level never enters the
      // chain properly, and one at the last has already been agreed twice; the middle is where a
      // half-applied decision would hide.
      const decided = await walkChain(
        row.approvalItemId,
        ApprovalDecisionAction.approve,
        2,
      );
      expect(decided?.state).toBe('rejected');

      const after = await sys.operatorFuelRecovery.findUnique({
        where: { id: row.id },
      });
      expect(after.status).toBe(OperatorRecoveryStatus.rejected);

      // **Unchanged.** Not "empty" — unchanged from before this recovery existed, which is the
      // only form of this assertion that survives the suite's earlier approved recovery still
      // being due. A rejected recovery collected anyway looks like success to everybody except the
      // operator whose wages were docked by a decision that went against it.
      const now = await payrollSees();
      expect(now.map((d) => d.recoveryId).sort()).toEqual(
        before.map((d) => d.recoveryId).sort(),
      );
      expect(now.map((d) => d.recoveryId)).not.toContain(row.id);
    });

    it('no longer blocks recovering the same loss from the hirer', async () => {
      /**
       * **The defect this test found, and the reason it is worth more than the status it asserts.**
       *
       * `assertNoOtherRecovery` treated any operator recovery that was not `reversed` as live. A
       * refused one therefore blocked `recover/hire-bill` for the same exception, refusing with
       * *"This loss is already being recovered from the other party"* — a sentence that was false,
       * because the recovery had been refused. So the moment after a Director said "do not dock the
       * operator", the one remaining way to recover the fuel was closed, and the refusal said the
       * opposite of what had happened.
       *
       * The exception is attributed to **both** parties, so attribution cannot be what blocks it.
       * What is asserted is the refusal's **code**: anything but
       * `FUEL_RECOVERY_ALREADY_RECOVERED`. It still fails — there is no hire bill in this fixture,
       * and building one would make a test about a refusal depend on a billing cycle — but it fails
       * for a true reason, which is the whole of the fix.
       */
      const res = await http()
        .post(`/plant/fuel-exceptions/${rejectedExceptionId}/recover/hire-bill`)
        .set(auth(reviewerToken))
        .send({});

      expect(res.body.code).not.toBe('FUEL_RECOVERY_ALREADY_RECOVERED');
      // Named rather than merely "not that one", so this test fails if the path starts refusing
      // for some third reason nobody intended.
      expect([
        'FUEL_RECOVERY_NO_HIRE_BILL',
        'FUEL_RECOVERY_NO_UNPAID_BILL',
      ]).toContain(res.body.code);
    });

    it('stays out of payroll’s reach permanently, not just until the next read', async () => {
      const rejected = await sys.operatorFuelRecovery.findFirst({
        where: { status: OperatorRecoveryStatus.rejected, companyId },
      });
      expect(rejected).not.toBeNull();

      // Read twice more. `dueForEmployees` filters on status, so a rejection that had been written
      // as `approved` by a second path — the handler firing on a rejected instance, say — would
      // show up here and nowhere else.
      expect((await payrollSees()).map((d) => d.recoveryId)).not.toContain(
        rejected.id,
      );
      expect((await payrollSees()).map((d) => d.recoveryId)).not.toContain(
        rejected.id,
      );
    });
  });
});
