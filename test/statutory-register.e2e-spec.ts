import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';
import { hash } from 'argon2';
import * as ExcelJS from 'exceljs';
import { Permission } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';
import { PiiCipherService } from '../src/hr/employees/pii-cipher.service';

/**
 * The monthly Statutory Compliance Register (040) against a real database, read back from the
 * workbook: four sheets in the client's layout, one serial per person across them, the processed
 * run's figures with a same-month F&F folded in, someone the run missed listed with a remark, a loan
 * on Form C, and the Form D day codes with merged New Joining / Left spans. July 2026: 31 days,
 * 1 July is a Wednesday, so the Sundays are 5, 12, 19 and 26. Fixtures prefixed `E2ESTR`.
 */
const PREFIX = 'E2ESTR';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;
const YEAR = 2026;
const MONTH = 7;
const PERIOD = '2026-07';

describe('Statutory compliance register (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let companyId: string;
  let siteId: string;
  let otherSiteId: string;
  let shiftId: string;
  let runId: string;
  let draftRunId: string;
  let payrollToken: string;
  let attendanceToken: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const codes: Record<string, string> = {};

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sys = (fn: (tx: any) => Promise<any>) =>
    withRlsContext(prisma, { isSuperAdmin: true }, fn);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const day = (d: number) => new Date(Date.UTC(YEAR, MONTH - 1, d));

  const makeUser = async (label: string, permissions: Permission[]) => {
    const password = await hash('secret42');
    const user = await sys((tx) =>
      tx.user.create({
        data: {
          email: `${unique(label)}@example.test`,
          username: unique(label),
          password,
          firstname: label,
          lastname: 'Tester',
          companyId,
        },
      }),
    );
    const role = await sys((tx) =>
      tx.role.create({ data: { name: unique(`${label}Role`), permissions } }),
    );
    await sys((tx) =>
      tx.userRole.create({ data: { userId: user.id, roleId: role.id } }),
    );
    userIds.push(user.id);
    roleIds.push(role.id);
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return login.body.accessToken as string;
  };

  const download = (token: string, id: string, query = '') =>
    http()
      .get(`/hr/payroll/runs/${id}/statutory-register/export${query}`)
      .set(auth(token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  const workbookOf = async (body: Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as unknown as ArrayBuffer);
    return wb;
  };
  const value = (ws: ExcelJS.Worksheet, row: number, col: number) => {
    const v = ws.getCell(row, col).value as any;
    return v && typeof v === 'object' && 'result' in v ? v.result : v;
  };
  /** The data row whose EMP.CODE / name column holds this employee. */
  const rowOf = (ws: ExcelJS.Worksheet, col: number, text: string) => {
    for (let r = 1; r <= ws.rowCount; r++) {
      if (String(ws.getCell(r, col).value ?? '') === text) return r;
    }
    throw new Error(`${text} not found in ${ws.name}`);
  };

  const money = {
    otHours: 0,
    otWages: 0,
    hra: 0,
    conveyanceAllowance: 0,
    siteAllowance: 0,
    specialAllowance: 0,
    employeeEsic: 0,
    professionalTax: 0,
    tds: 0,
    loanEmiDeduction: 0,
    employerPf: 0,
    employerEps: 0,
    employerEsic: 0,
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    const pii = app.get(PiiCipherService);
    http = () => request(app.getHttpServer());

    companyId = (
      await sys((tx) =>
        tx.company.create({
          data: {
            name: 'Dummy Register Test Firm',
            shortCode: unique('SR').slice(0, 10),
            payrollLockDay: 7,
            pfEmployerRate: 12,
            esicEmployerRate: 3.25,
            gratuityRate: 4.81,
            bonusRate: 8.33,
            pfEstablishmentCode: 'DUMMY/PF/1',
          },
        }),
      )
    ).id;
    const site = (name: string) =>
      sys((tx) =>
        tx.site.create({
          data: {
            companyId,
            name: unique(name),
            latitude: 19.076,
            longitude: 72.8777,
            geofenceRadiusMeters: 200,
            weeklyOffDay: 0,
          },
        }),
      );
    siteId = (await site('Dummy Site')).id;
    otherSiteId = (await site('Dummy Other Site')).id;
    shiftId = (
      await sys((tx) =>
        tx.shift.create({
          data: {
            companyId,
            name: unique('Shift'),
            inTime: new Date('1970-01-01T09:00:00.000Z'),
            outTime: new Date('1970-01-01T18:00:00.000Z'),
            graceMinutes: 10,
          },
        }),
      )
    ).id;

    const employee = async (
      key: string,
      extra: Record<string, unknown> = {},
    ) => {
      codes[key] = `${String(Object.keys(codes).length + 1).padStart(
        2,
        '0',
      )}${unique(key)}`.slice(0, 16);
      return sys((tx) =>
        tx.employee.create({
          data: {
            companyId,
            siteId,
            shiftId,
            employeeCode: codes[key],
            firstName: `Dummy ${key}`,
            basic: 20000,
            hra: 10000,
            dateOfJoining: new Date('2025-01-01'),
            ...extra,
          },
        }),
      );
    };
    const steady = await employee('Steady', {
      fatherName: 'Dummy Father',
      aadhaarEncrypted: pii.encrypt('012345678901'),
      bankAccountNumberEncrypted: pii.encrypt('0012345678'),
      ifscCode: 'DUMY0000001',
      uan: '100200300400',
      esicNumber: '1514000001',
      pfApplicable: true,
      esicApplicable: true,
      paymentMode: 'Bank',
    });
    const joiner = await employee('Joiner', { dateOfJoining: day(20) });
    const leaver = await employee('Leaver', { isActive: false });
    const unpaid = await employee('Unpaid');
    await employee('Elsewhere', { siteId: otherSiteId });
    await sys((tx) =>
      tx.exitRecord.create({
        data: {
          employeeId: leaver.id,
          lastWorkingDay: day(10),
          reason: 'resignation',
          initiatedByUserId: 'system',
        },
      }),
    );

    // Steady works every weekday but the 2nd; the joiner from the 20th; the leaver to the 10th.
    const punch = (employeeId: string, d: number) =>
      sys((tx) =>
        tx.punchRecord.create({
          data: {
            employeeId,
            type: 'in',
            capturedAt: new Date(Date.UTC(YEAR, MONTH - 1, d, 4, 0)),
            punchDate: day(d),
            source: 'admin_correction',
          },
        }),
      );
    for (let d = 1; d <= 31; d++) {
      const sunday = day(d).getUTCDay() === 0;
      if (sunday) continue;
      if (d !== 2) await punch(steady.id, d);
      if (d >= 20) await punch(joiner.id, d);
      if (d <= 10) await punch(leaver.id, d);
    }
    void unpaid;

    const run = await sys((tx) =>
      tx.payrollRun.create({
        data: {
          companyId,
          period: PERIOD,
          status: 'paid',
          processedAt: new Date('2026-08-01T10:00:00Z'),
          paidAt: new Date('2026-08-05T10:00:00Z'),
        },
      }),
    );
    runId = run.id;
    const steadyLine = await sys((tx) =>
      tx.payrollLineItem.create({
        data: {
          ...money,
          payrollRunId: run.id,
          employeeId: steady.id,
          monthDays: 31,
          payableDays: 30,
          lopDays: 1,
          basic: 19354.84,
          hra: 9677.42,
          employeePf: 1800,
          employeeEsic: 0,
          professionalTax: 200,
          loanEmiDeduction: 1000,
          netPay: 26032.26,
          employerPf: 550,
          employerEps: 1250,
        },
      }),
    );
    await sys((tx) =>
      tx.payrollLineItem.create({
        data: {
          ...money,
          payrollRunId: run.id,
          employeeId: joiner.id,
          monthDays: 31,
          payableDays: 12,
          basic: 7741.94,
          hra: 3870.97,
          netPay: 11612.91,
        },
      }),
    );
    const fnf = await sys((tx) =>
      tx.payrollRun.create({
        data: {
          companyId,
          period: PERIOD,
          isFnf: true,
          status: 'processed',
          processedAt: new Date('2026-07-15T10:00:00Z'),
        },
      }),
    );
    await sys((tx) =>
      tx.payrollLineItem.create({
        data: {
          ...money,
          payrollRunId: fnf.id,
          employeeId: leaver.id,
          monthDays: 0,
          payableDays: 0,
          basic: 6451.61,
          specialAllowance: 2000,
          professionalTax: 774.19,
          netPay: 7677.42,
        },
      }),
    );
    draftRunId = (
      await sys((tx) =>
        tx.payrollRun.create({
          data: { companyId, period: '2026-06', status: 'draft' },
        }),
      )
    ).id;

    // A loan with this month's EMI recovered in the run.
    await sys((tx) =>
      tx.loan.create({
        data: {
          companyId,
          employeeId: steady.id,
          amount: 3000,
          emiAmount: 1000,
          disbursementDate: new Date('2026-06-10'),
          reason: 'Dummy medical loan',
          status: 'active',
          schedule: {
            create: [
              {
                month: '2026-07',
                emiAmount: 1000,
                principal: 1000,
                remainingBalance: 2000,
                status: 'paid',
                paidInPayrollRunId: run.id,
              },
              {
                month: '2026-08',
                emiAmount: 1000,
                principal: 1000,
                remainingBalance: 1000,
              },
              {
                month: '2026-09',
                emiAmount: 1000,
                principal: 1000,
                remainingBalance: 0,
              },
            ],
          },
        },
      }),
    );
    void steadyLine;

    payrollToken = await makeUser('payroll', [Permission.PAYROLL]);
    attendanceToken = await makeUser('attendance', [Permission.ATTENDANCE]);
  });

  afterAll(async () => {
    if (companyId) {
      const emps = await sys((tx) =>
        tx.employee.findMany({ where: { companyId }, select: { id: true } }),
      );
      const ids = emps.map((e: { id: string }) => e.id);
      await sys((tx) => tx.loan.deleteMany({ where: { companyId } }));
      await sys((tx) => tx.payrollRun.deleteMany({ where: { companyId } }));
      await sys((tx) =>
        tx.punchRecord.deleteMany({ where: { employeeId: { in: ids } } }),
      );
      await sys((tx) =>
        tx.exitRecord.deleteMany({ where: { employeeId: { in: ids } } }),
      );
      await sys((tx) => tx.employee.deleteMany({ where: { id: { in: ids } } }));
      await sys((tx) => tx.shift.deleteMany({ where: { companyId } }));
      await sys((tx) => tx.site.deleteMany({ where: { companyId } }));
    }
    for (const id of userIds) {
      await sys((tx) => tx.userRole.deleteMany({ where: { userId: id } }));
      await sys((tx) =>
        tx.refreshToken.deleteMany({ where: { accountId: id } }),
      );
      await sys((tx) =>
        tx.auditLogEntry.updateMany({
          where: { accountId: id },
          data: { accountId: null },
        }),
      );
      await sys((tx) => tx.user.deleteMany({ where: { id } }));
    }
    for (const id of roleIds)
      await sys((tx) => tx.role.deleteMany({ where: { id } }));
    if (companyId) {
      await sys((tx) => tx.auditLogEntry.deleteMany({ where: { companyId } }));
      await sys((tx) => tx.company.deleteMany({ where: { id: companyId } }));
    }
    await app.close();
  });

  it('refuses a draft run and a caller without PAYROLL', async () => {
    expect((await download(payrollToken, draftRunId)).status).toBe(400);
    expect((await download(attendanceToken, runId)).status).toBe(403);
  });

  it('builds the four sheets with one serial per person', async () => {
    const res = await download(payrollToken, runId);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(
      'Statutory_Register_Dummy_Register_Test_Firm_July_2026.xlsx',
    );
    const wb = await workbookOf(res.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'A- EMPLOYEE REGISTER',
      'B- WAGES REGISTER',
      'C- LOAN RECOVERIES',
      'D- ATTENDANCE REGISTER',
    ]);

    // Employee register: everyone employed in the month, in code order; unmasked IDs kept as text.
    const a = wb.getWorksheet('A- EMPLOYEE REGISTER')!;
    expect(a.getCell(1, 6).value).toBe('Adhaar card');
    const names = [2, 3, 4, 5, 6].map((r) => a.getCell(r, 2).value);
    expect(names).toEqual([
      'Dummy Steady',
      'Dummy Joiner',
      'Dummy Leaver',
      'Dummy Unpaid',
      'Dummy Elsewhere',
    ]);
    expect(a.getCell(2, 3).value).toBe('Dummy Father');
    expect(a.getCell(2, 6).value).toBe('012345678901');
    expect(a.getCell(2, 9).value).toBe('0012345678');
    expect(a.getCell(2, 12).value).toBe('100200300400');
    expect(a.getCell(3, 14).value).toBe('New Joining');
    expect(String(a.getCell(4, 14).value)).toContain('Left on 10-07-2026');

    // Wage register: run figures, F&F folded in, the unpaid person listed with a remark.
    const b = wb.getWorksheet('B- WAGES REGISTER')!;
    expect(b.getCell(1, 1).value).toBe('FORM B');
    expect(String(b.getCell(5, 1).value)).toContain('DUMMY/PF/1');
    expect(b.getCell(8, 1).value).toBe('Month of July 2026');
    const s = rowOf(b, 2, codes.Steady);
    expect(value(b, s, 1)).toBe(1);
    expect(value(b, s, 3)).toBe('100200300400');
    expect(value(b, s, 4)).toBe('1514000001');
    expect(value(b, s, 7)).toBe(30000); // monthly gross from the salary heads
    expect(value(b, s, 8)).toBe(20000);
    expect(value(b, s, 9)).toBe(30);
    expect(value(b, s, 11)).toBe(19354.84);
    expect(value(b, s, 15)).toBe(9677.42);
    expect(value(b, s, 17)).toBe(29032.26);
    expect(value(b, s, 18)).toBe(1800);
    expect(value(b, s, 23)).toBe(200);
    expect(value(b, s, 24)).toBe(1000);
    expect(value(b, s, 25)).toBe(3000);
    expect(value(b, s, 26)).toBe(26032.26);
    expect(value(b, s, 27)).toBe(1800);
    expect(value(b, s, 28)).toBe('Bank transfer');
    expect(value(b, s, 29)).toEqual(new Date('2026-08-05T00:00:00Z'));
    expect(value(b, s, 31)).toBe(19354.84); // PF gross

    const l = rowOf(b, 2, codes.Leaver);
    expect(value(b, l, 9)).toBe(10); // F&F days from the calendar: worked to the 10th
    expect(value(b, l, 26)).toBe(7677.42);
    expect(String(value(b, l, 30))).toContain('Full & final settlement');
    // Paid through the F&F run, which is processed but not yet marked paid.
    expect(value(b, l, 28)).toBeNull();
    expect(value(b, l, 29)).toBeNull();

    const u = rowOf(b, 2, codes.Unpaid);
    expect(value(b, u, 26)).toBeNull();
    expect(String(value(b, u, 30))).toContain('Not in this month’s payroll');

    const total = rowOf(b, 1, 'TOTAL');
    expect(value(b, total, 26)).toBeCloseTo(26032.26 + 11612.91 + 7677.42, 2);

    // Form C: the loan with this month's recovery.
    const c = wb.getWorksheet('C- LOAN RECOVERIES')!;
    expect(c.getCell(2, 1).value).toBe('REGISTER OF LOAN/RECOVERIES');
    expect(c.getCell(7, 1).value).toBe(1);
    expect(c.getCell(7, 3).value).toBe('Loan');
    expect(c.getCell(7, 6).value).toBe(3000);
    expect(c.getCell(7, 9).value).toBe(3);
    expect(c.getCell(7, 10).value).toBe('07/2026');
    expect(c.getCell(7, 11).value).toBe('09/2026');
    expect(c.getCell(7, 12).value).toBeNull();
    expect(String(c.getCell(7, 13).value)).toContain('Recovered this month');

    // Form D: O on Sundays, A on the missed day, merged New Joining / Left spans.
    const d = wb.getWorksheet('D- ATTENDANCE REGISTER')!;
    expect(d.getCell(8, 8).value).toBe(1);
    expect(d.getCell(9, 8).value).toBe('W');
    const sd = rowOf(d, 2, codes.Steady);
    expect(d.getCell(sd, 8).value).toBe('P');
    expect(d.getCell(sd, 9).value).toBe('A');
    expect(d.getCell(sd, 12).value).toBe('O'); // 5 July, a Sunday
    expect(value(d, sd, 40)).toBe(4); // weekly offs
    expect(value(d, sd, 42)).toBe(26); // present
    expect(value(d, sd, 43)).toBe(30); // total
    expect(value(d, sd, 39)).toBe(30); // pay days from the run
    const jd = rowOf(d, 2, codes.Joiner);
    expect(d.getCell(jd, 8).value).toBe('New Joining');
    expect(d.getCell(jd, 26).master.address).toBe(d.getCell(jd, 8).address);
    expect(d.getCell(jd, 27).value).toBe('P'); // the 20th
    const ld = rowOf(d, 2, codes.Leaver);
    expect(d.getCell(ld, 18).value).toBe('Left'); // from the 11th
  });

  it('narrows to a site and records the download in the audit log', async () => {
    const res = await download(payrollToken, runId, `?siteId=${otherSiteId}`);
    expect(res.status).toBe(200);
    const wb = await workbookOf(res.body);
    const a = wb.getWorksheet('A- EMPLOYEE REGISTER')!;
    expect(a.getCell(2, 2).value).toBe('Dummy Elsewhere');
    expect(a.getCell(3, 2).value).toBeNull();
    // Nothing given or recovered for that site: NIL, as the client writes it.
    expect(wb.getWorksheet('C- LOAN RECOVERIES')!.getCell(7, 1).value).toBe(
      'NIL',
    );

    const audits = await sys((tx) =>
      tx.auditLogEntry.findMany({
        where: { companyId, entityType: 'PAYROLL_RUN', entityId: runId },
      }),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].changes).toMatchObject({
      export: 'statutory_register',
      period: PERIOD,
    });
  });
});
