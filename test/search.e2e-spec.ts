import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Permission } from '@prisma/client';
import { hash } from 'argon2';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * Cross-register search over HTTP (021 US1, T014, T015, T021, T022, T024, T026) —
 * `bugs.md` item 4.
 *
 * Driven over HTTP rather than through the container because every claim is about the
 * endpoint: that a name substring finds a project, that an exact code outranks it, that a
 * cap is admitted rather than hidden, and — the one that matters most — that a register
 * the caller may not see is **indistinguishable** from a register with no matches.
 *
 * Every fixture is prefixed `E2ESR` and removed in `afterAll`.
 */
const PREFIX = 'E2ESR';
const unique = (s: string) =>
  `${PREFIX}${s}${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;

jest.setTimeout(60_000);

describe('Cross-register search (e2e)', () => {
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
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let companyId: string;
  let otherCompanyId: string;
  /** The searchable term every fixture shares, so one query reaches all four registers. */
  let token: string;
  /** Holds every register's permission. */
  let allToken: string;
  /** Holds PROJECTS only — the caller T015 uses to prove non-disclosure. */
  let projectsOnlyToken: string;
  /** Holds nothing at all. */
  let nothingToken: string;

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const projectIds: string[] = [];
  const employeeIds: string[] = [];
  let clientId: string;
  let siteId: string;
  let shiftId: string;
  let categoryId: string;
  let vendorId: string;
  let equipmentId: string;

  /** The shared name token. Distinctive enough that nothing else in the database has it. */
  const NEEDLE = 'Zarvolix';

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
      data: { name: unique(`${label}Role`), permissions },
    });
    roleIds.push(role.id);
    await sys.userRole.create({
      data: { userId: user.id, roleId: role.id, companyId },
    });
    const login = await http()
      .post('/auth/login')
      .send({ identifier: user.email, password: 'secret42', rememberMe: false })
      .expect(201);
    return { userId: user.id, token: login.body.accessToken as string };
  };

  const newCompany = async (name: string) =>
    sys.company.create({
      data: {
        name,
        shortCode: unique('S').slice(0, 10),
        payrollLockDay: 7,
        pfEmployerRate: 12,
        esicEmployerRate: 3.25,
        gratuityRate: 4.81,
        bonusRate: 8.33,
      },
    });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    http = () => request(app.getHttpServer());
    prisma = app.get(PrismaService);

    companyId = (await newCompany(`${PREFIX} Search Constructions`)).id;
    otherCompanyId = (await newCompany(`${PREFIX} Other Constructions`)).id;

    const client = await sys.client.create({
      data: { companyId, name: `${PREFIX} Client` },
    });
    clientId = client.id;

    // A project found by NAME substring, with a code that shares no prefix with it.
    const named = await sys.project.create({
      data: {
        companyId,
        clientId,
        code: unique('PRJ'),
        name: `Parth ${NEEDLE} Phase II`,
        contractValue: 1000,
        startDate: new Date('2026-01-01'),
      },
    });
    projectIds.push(named.id);

    // A project in the OTHER company with the same name, so company scoping is asserted
    // against a real row rather than an empty list — an empty list is what a broken scope
    // and a correct one both look like when there is nothing to find.
    const otherClient = await sys.client.create({
      data: { companyId: otherCompanyId, name: `${PREFIX} Other Client` },
    });
    const otherProject = await sys.project.create({
      data: {
        companyId: otherCompanyId,
        clientId: otherClient.id,
        code: unique('OPRJ'),
        name: `Other ${NEEDLE} Yard`,
        contractValue: 1000,
        startDate: new Date('2026-01-01'),
      },
    });
    projectIds.push(otherProject.id);

    // A vendor whose CODE is exactly the needle — the exact-code tier in FR-001b.
    const vendor = await sys.vendor.create({
      data: {
        companyId,
        code: NEEDLE.toUpperCase(),
        name: `${NEEDLE} Traders`,
        type: 'material',
      },
    });
    vendorId = vendor.id;

    const category = await sys.equipmentCategory.create({
      data: { companyId, name: unique('Cat'), meterType: 'hours' },
    });
    categoryId = category.id;
    const equipment = await sys.equipment.create({
      data: {
        companyId,
        code: unique('EQP'),
        name: `${NEEDLE} Excavator`,
        categoryId,
        ownership: 'owned',
        powerSource: 'diesel',
        meterType: 'hours',
      },
    });
    equipmentId = equipment.id;

    const site = await sys.site.create({
      data: {
        companyId,
        name: unique('Site'),
        latitude: 20,
        longitude: 78,
        geofenceRadiusMeters: 100,
        weeklyOffDay: 0,
      },
    });
    siteId = site.id;
    const shift = await sys.shift.create({
      data: {
        companyId,
        name: unique('Shift'),
        inTime: new Date('1970-01-01T09:00:00Z'),
        outTime: new Date('1970-01-01T18:00:00Z'),
      },
    });
    shiftId = shift.id;

    const all = await makeUser('all', [
      Permission.PROJECTS,
      Permission.PARTNERS,
      Permission.MACHINERY,
      Permission.EMPLOYEES,
    ]);
    allToken = all.token;
    token = all.token;

    // An employee whose LAST name only is the needle — the null-first-name case a
    // concatenated predicate would silently drop.
    const employee = await sys.employee.create({
      data: {
        userId: all.userId,
        companyId,
        siteId,
        shiftId,
        employeeCode: unique('EMP'),
        firstName: null,
        lastName: NEEDLE,
      },
    });
    employeeIds.push(employee.id);

    projectsOnlyToken = (await makeUser('projonly', [Permission.PROJECTS]))
      .token;
    nothingToken = (await makeUser('nothing', [])).token;
  });

  afterAll(async () => {
    await sys.employee.deleteMany({ where: { id: { in: employeeIds } } });
    await sys.equipment.deleteMany({ where: { id: equipmentId } });
    await sys.equipmentCategory.deleteMany({ where: { id: categoryId } });
    await sys.vendor.deleteMany({ where: { id: vendorId } });
    await sys.project.deleteMany({ where: { id: { in: projectIds } } });
    await sys.client.deleteMany({
      where: { companyId: { in: [companyId, otherCompanyId] } },
    });
    await sys.shift.deleteMany({ where: { id: shiftId } });
    await sys.site.deleteMany({ where: { id: siteId } });
    await sys.userRole.deleteMany({ where: { userId: { in: userIds } } });
    // Before the users: every `makeUser` signs in, and a sign-in writes a RefreshToken
    // whose foreign key would otherwise refuse the delete.
    await sys.refreshToken.deleteMany({
      where: { accountId: { in: userIds } },
    });
    await sys.user.deleteMany({ where: { id: { in: userIds } } });
    await sys.role.deleteMany({ where: { id: { in: roleIds } } });
    await sys.company.deleteMany({
      where: { id: { in: [companyId, otherCompanyId] } },
    });
    await app.close();
  });

  const search = (t: string, q: string) =>
    http()
      .get(`/search?q=${encodeURIComponent(q)}`)
      .set(auth(t));

  // ---------------------------------------------------------------- T014, quickstart 1

  it('finds a project by a name substring and reports the match as a name', async () => {
    const res = await search(token, NEEDLE).expect(200);
    const project = res.body.results.find(
      (r: { register: string }) => r.register === 'project',
    );
    expect(project).toBeDefined();
    expect(project.label).toContain(NEEDLE);
    expect(project.matchedOn).toBe('name');
    expect(project.href).toBe(`/projects/${projectIds[0]}`);
  });

  it('finds the same project by a partial code and reports the match as a code', async () => {
    const created = await sys.project.findFirst({
      where: { id: projectIds[0] },
      select: { code: true },
    });
    const partial = created.code.slice(0, 8);
    const res = await search(token, partial).expect(200);
    const project = res.body.results.find(
      (r: { register: string }) => r.register === 'project',
    );
    expect(project).toBeDefined();
    expect(project.matchedOn).toBe('code');
  });

  it('refuses a term shorter than the minimum with a 400, not an empty list', async () => {
    // The client needs to say "keep typing"; it cannot distinguish that from "nothing
    // matched" if both are an empty array.
    await search(token, 'ab').expect(400);
  });

  // ---------------------------------------------------------------- T021, quickstart 2

  it('reaches all four registers in one search, each with its own register and href', async () => {
    const res = await search(allToken, NEEDLE).expect(200);
    const registers = res.body.results.map(
      (r: { register: string }) => r.register,
    );
    expect(new Set(registers)).toEqual(
      new Set(['project', 'vendor', 'equipment', 'employee']),
    );
    for (const row of res.body.results) {
      expect(typeof row.href).toBe('string');
      expect(row.href.length).toBeGreaterThan(1);
    }
  });

  it('finds the employee whose last name only is the term', async () => {
    const res = await search(allToken, NEEDLE).expect(200);
    const employee = res.body.results.find(
      (r: { register: string }) => r.register === 'employee',
    );
    expect(employee).toBeDefined();
    expect(employee.label).toBe(NEEDLE);
  });

  it('never returns another company’s record', async () => {
    const res = await search(allToken, NEEDLE).expect(200);
    const ids = res.body.results.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(projectIds[1]);
  });

  // ------------------------------------------------- T015, quickstart 3 — THE CRITICAL ONE

  it('discloses nothing about a register the caller may not see', async () => {
    // A caller holding PROJECTS only must receive a response byte-identical in shape to
    // one where the other three registers simply had no matches: the records absent,
    // `unavailableSources` empty, and nothing anywhere naming a register they cannot
    // reach. `unavailableSources` means "we could not ask" — using it here would disclose
    // exactly what FR-002 forbids.
    const res = await search(projectsOnlyToken, NEEDLE).expect(200);

    const registers = res.body.results.map(
      (r: { register: string }) => r.register,
    );
    expect(new Set(registers)).toEqual(new Set(['project']));
    expect(res.body.unavailableSources).toEqual([]);

    const serialised = JSON.stringify(res.body);
    for (const leaked of ['vendor', 'equipment', 'employee']) {
      expect(serialised).not.toContain(leaked);
    }
  });

  it('discloses nothing for a NAME match either, not only a code match', async () => {
    // FR-001c exists because a name is not a weaker key for authorisation purposes. The
    // vendor here matches by code and the equipment by name; both must be equally absent.
    const res = await search(projectsOnlyToken, NEEDLE).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('Excavator');
    expect(JSON.stringify(res.body)).not.toContain('Traders');
  });

  it('returns an empty result, not an error, for a caller holding no register', async () => {
    const res = await search(nothingToken, NEEDLE).expect(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.unavailableSources).toEqual([]);
    expect(res.body.truncated).toBe(false);
  });

  // ---------------------------------------------------------------- T024, quickstart 4

  it('ranks an exact code match above a name match', async () => {
    // The vendor's code is exactly the needle; the project merely contains it. Only the
    // tier is asserted — a test pinning intra-tier order fails on unrelated changes and
    // teaches the next person to loosen the wrong assertion.
    const res = await search(allToken, NEEDLE.toUpperCase()).expect(200);
    expect(res.body.results[0].code).toBe(NEEDLE.toUpperCase());
    expect(res.body.results[0].register).toBe('vendor');
  });

  // ---------------------------------------------------------------- T026, quickstart 5

  it('admits truncation rather than silently showing the first handful', async () => {
    // More projects than the total cap, all matching. The spec's "a search that would
    // match thousands" edge case, answered honestly.
    const bulk: string[] = [];
    for (let i = 0; i < 35; i += 1) {
      const p = await sys.project.create({
        data: {
          companyId,
          clientId,
          code: unique(`BULK${i}`),
          name: `Bulk ${NEEDLE} ${i}`,
          contractValue: 1,
          startDate: new Date('2026-01-01'),
        },
      });
      bulk.push(p.id);
      projectIds.push(p.id);
    }

    const res = await search(allToken, NEEDLE).expect(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.results.length).toBeLessThanOrEqual(30);

    await sys.project.deleteMany({ where: { id: { in: bulk } } });
  });

  // ---------------------------------------------------------------------------- guards

  it('requires authentication', async () => {
    await http().get(`/search?q=${NEEDLE}`).expect(401);
  });
});
