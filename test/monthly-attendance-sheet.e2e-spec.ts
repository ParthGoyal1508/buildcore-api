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

/**
 * The monthly staff attendance download (2026-10-17) against a real database, read back from the
 * workbook: the client's header block, P / A / W/O / H / NEW JOINING / LEFT codes in the day
 * columns, the counts, and salary columns only for a caller who may see pay. A month safely in
 * the past (Sept 2026) so no payroll lock or "today" interferes. Fixtures prefixed `E2EMAS`.
 */
const PREFIX = 'E2EMAS';
const unique = (s: string) => `${PREFIX}${s}${Date.now() % 100000}`;
const YEAR = 2026;
const MONTH = 9; // 30 days; 6 Sept 2026 is a Sunday.

describe('Monthly attendance sheet (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: () => request.SuperTest<request.Test>;
  let companyId: string;
  let otherCompanyId: string;
  let siteId: string;
  let shiftId: string;
  let hrToken: string;
  let payrollToken: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

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

  const download = async (token: string, query = '') => {
    const res = await http()
      .get(`/hr/attendance/monthly-sheet?year=${YEAR}&month=${MONTH}${query}`)
      .set(auth(token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    return res;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());

    const mk = (name: string) =>
      sys((tx) =>
        tx.company.create({
          data: {
            name,
            shortCode: unique(name.slice(6, 8)).slice(0, 10),
            payrollLockDay: 7,
            pfEmployerRate: 12,
            esicEmployerRate: 3.25,
            gratuityRate: 4.81,
            bonusRate: 8.33,
          },
        }),
      );
    companyId = (await mk('Dummy Attendance Test Firm')).id;
    otherCompanyId = (await mk('Dummy Other Test Firm')).id;
    siteId = (
      await sys((tx) =>
        tx.site.create({
          data: {
            companyId,
            name: unique('Dummy Site'),
            latitude: 19.076,
            longitude: 72.8777,
            geofenceRadiusMeters: 200,
            weeklyOffDay: 0,
          },
        }),
      )
    ).id;
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
    await sys((tx) =>
      tx.holiday.create({
        data: { companyId, name: 'Dummy Holiday', date: day(15) },
      }),
    );

    const employee = (code: string, extra: Record<string, unknown>) =>
      sys((tx) =>
        tx.employee.create({
          data: {
            companyId,
            siteId,
            shiftId,
            employeeCode: unique(code).slice(0, 14),
            firstName: `Dummy ${code}`,
            basic: 20000,
            hra: 10000,
            ...extra,
          },
        }),
      );
    const steady = await employee('Steady', { dateOfJoining: day(1) });
    const joiner = await employee('Joiner', { dateOfJoining: day(20) });
    const leaver = await employee('Leaver', {
      dateOfJoining: new Date('2025-01-01'),
    });
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
    // Steady works 1-4 and 7; the leaver works the 2nd; the joiner works the 21st.
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
    for (const d of [1, 2, 3, 4, 7]) await punch(steady.id, d);
    await punch(leaver.id, 2);
    await punch(joiner.id, 21);

    hrToken = await makeUser('hr', [Permission.ATTENDANCE]);
    payrollToken = await makeUser('payroll', [
      Permission.ATTENDANCE,
      Permission.PAYROLL,
    ]);
  });

  afterAll(async () => {
    for (const id of [companyId, otherCompanyId].filter(Boolean)) {
      const emps = await sys((tx) =>
        tx.employee.findMany({
          where: { companyId: id },
          select: { id: true },
        }),
      );
      const ids = emps.map((e: { id: string }) => e.id);
      await sys((tx) =>
        tx.punchRecord.deleteMany({ where: { employeeId: { in: ids } } }),
      );
      await sys((tx) =>
        tx.exitRecord.deleteMany({ where: { employeeId: { in: ids } } }),
      );
      await sys((tx) => tx.employee.deleteMany({ where: { id: { in: ids } } }));
      await sys((tx) => tx.holiday.deleteMany({ where: { companyId: id } }));
      await sys((tx) => tx.shift.deleteMany({ where: { companyId: id } }));
      await sys((tx) => tx.site.deleteMany({ where: { companyId: id } }));
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
    for (const id of [companyId, otherCompanyId].filter(Boolean)) {
      await sys((tx) => tx.company.deleteMany({ where: { id } }));
    }
    await app.close();
  });

  it('downloads the client layout with the right codes and counts', async () => {
    const res = await download(payrollToken);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(
      'Attendance_Dummy_Attendance_Test_Firm_September_2026.xlsx',
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    expect(wb.worksheets).toHaveLength(1);
    const ws = wb.worksheets[0];
    expect(ws.getCell('A1').value).toBe('Company: Dummy Attendance Test Firm');
    expect(String(ws.getCell('A2').value)).toMatch(/^Site: /);
    expect([
      ws.getCell('A3').value,
      ws.getCell('B3').value,
      ws.getCell('C3').value,
    ]).toEqual(['Month:', 'Sept', 2026]);
    expect(ws.getCell('A6').value).toBe('STAFF ATTENDANCE');
    expect(ws.getCell('A7').value).toBe('Sr. No');
    expect(ws.getCell('E7').value).toBe('Tue'); // 1 Sept 2026
    expect(ws.getCell('AJ7').value).toBe('Present Days');
    expect(ws.getCell('AL7').value).toBe('Total Payable Days');
    expect(ws.getCell('AP7').value).toBe('Remark');

    const rowOf = (name: string) => {
      for (let r = 9; r <= ws.rowCount; r++) {
        if (ws.getCell(r, 3).value === name) return ws.getRow(r);
      }
      throw new Error(`no row for ${name}`);
    };
    const dayCell = (row: ExcelJS.Row, d: number) => row.getCell(4 + d).value;
    const result = (row: ExcelJS.Row, col: string) =>
      (row.getCell(col).value as { result: number }).result;

    const steady = rowOf('Dummy Steady');
    expect([1, 2, 5, 6, 7, 15].map((d) => dayCell(steady, d))).toEqual([
      'P',
      'P',
      'A',
      'W/O',
      'P',
      'H',
    ]);
    expect(dayCell(steady, 31)).toBeNull(); // September has 30 days
    expect(result(steady, 'AJ')).toBe(5);
    expect(steady.getCell('AM').value).toBe(30000);
    expect(result(steady, 'AN')).toBe(1000);

    const joiner = rowOf('Dummy Joiner');
    expect(dayCell(joiner, 19)).toBe('NEW JOINING');
    expect(dayCell(joiner, 21)).toBe('P');

    const leaver = rowOf('Dummy Leaver');
    expect(dayCell(leaver, 2)).toBe('P');
    expect(dayCell(leaver, 11)).toBe('LEFT');
  });

  it('leaves salary columns empty for someone without payroll access', async () => {
    const res = await download(hrToken);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.getCell('AM9').value).toBeNull();
    expect(ws.getCell('AO9').value).toBeNull();
  });

  it('never serves a company the caller cannot open', async () => {
    const res = await download(hrToken, `&companyId=${otherCompanyId}`);
    // A company-scoped caller is pinned to their own company whatever they ask for.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    expect(wb.worksheets[0].getCell('A1').value).toBe(
      'Company: Dummy Attendance Test Firm',
    );
  });
});
