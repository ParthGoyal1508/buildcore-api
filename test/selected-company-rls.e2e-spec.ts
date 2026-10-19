import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccessLevel, Permission, PrismaClient } from '@prisma/client';
import { hash } from 'argon2';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';

/**
 * The approval spine reads under the **selected** company (036 B2) — with row-level security
 * actually in force.
 *
 * ## Why the whole application runs as a probe role here
 *
 * The local and CI database role is a superuser, and Postgres exempts superusers from every
 * policy. The defect was that `stateOf`/`statesOf`/`historyOf` set the RLS context to the
 * viewer's *home* company; their queries filter by entity alone, so under a superuser they find
 * the row anyway and the bug is invisible. The other `*-rls` suites query tables directly as a
 * probe; this one boots the **application** on a `NOSUPERUSER NOBYPASSRLS` login, so the request
 * path itself is what the policy judges.
 *
 * The scenario is the audit's: a Super Admin whose home company is A selects B and opens B's
 * approval history. Before the fix: an empty list. After: B's decision.
 */
const PROBE_ROLE = 'buildcore_app_rls_probe';
const PROBE_PASSWORD = 'probe-only-never-a-real-secret';
const SCHEMAS = [
  'public',
  'shared',
  'settings',
  'hr',
  'payroll',
  'projects',
  'partners',
  'inventory',
  'plant',
  'labour',
  'recruitment',
  'assets',
];

function probeUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

jest.setTimeout(180_000);

describe('approval spine under the selected company, RLS in force (036 B2)', () => {
  let admin: PrismaClient;
  let app: INestApplication | null = null;
  let canProbe = false;
  const adminUrl = process.env.DATABASE_URL as string;

  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const companyA = `E2ESCA${stamp}`;
  const companyB = `E2ESCB${stamp}`;
  const entityType = 'e2e_selected_company';
  const entityId = `E2ESCENT${stamp}`;
  const ids = { role: '', user: '', instance: '', chain: '' };
  let email = '';

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
    const [role] = await admin.$queryRaw<{ rolsuper: boolean }[]>`
      SELECT rolsuper FROM pg_roles WHERE rolname = current_user
    `;
    if (!role?.rolsuper) {
      // eslint-disable-next-line no-console
      console.warn(
        'RLS NOT in force for this suite: the current role cannot CREATE ROLE. Run as a superuser.',
      );
      return;
    }

    const exists = await admin.$queryRaw<{ n: number }[]>`
      SELECT 1 AS n FROM pg_roles WHERE rolname = ${PROBE_ROLE}
    `;
    if (exists.length === 0) {
      await admin.$executeRawUnsafe(
        `CREATE ROLE "${PROBE_ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PROBE_PASSWORD}'`,
      );
    }
    for (const schema of SCHEMAS) {
      await admin.$executeRawUnsafe(
        `GRANT USAGE ON SCHEMA "${schema}" TO "${PROBE_ROLE}"`,
      );
      await admin.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${PROBE_ROLE}"`,
      );
      await admin.$executeRawUnsafe(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${PROBE_ROLE}"`,
      );
    }
    canProbe = true;

    // Fixtures, written as the superuser.
    for (const id of [companyA, companyB]) {
      await admin.$executeRawUnsafe(
        `INSERT INTO "settings"."Company" ("id","name","shortCode","payrollLockDay","pfEmployerRate","esicEmployerRate","gratuityRate","bonusRate","createdAt","updatedAt")
         VALUES ($1,$2,$3,7,12,3.25,4.81,8.33,NOW(),NOW())`,
        id,
        `E2E Dummy ${id} Test Firm`,
        id.slice(0, 10),
      );
    }
    const created = await admin.role.create({
      data: {
        name: `E2ESC role ${stamp}`,
        permissions: [Permission.CROSS_COMPANY_ACCESS, Permission.ATTENDANCE],
        rolePermissions: {
          create: [
            Permission.CROSS_COMPANY_ACCESS,
            Permission.ATTENDANCE,
          ].flatMap((permission) => [
            { permission, level: AccessLevel.read },
            { permission, level: AccessLevel.write },
          ]),
        },
      },
    });
    ids.role = created.id;
    email = `e2esc${stamp}@example.test`;
    const user = await admin.user.create({
      data: {
        email,
        username: `e2esc${stamp}`,
        password: await hash('secret42'),
        displayName: 'E2E selected-company viewer',
        companyId: companyA,
        status: 'active',
      },
    });
    ids.user = user.id;
    await admin.userRole.create({
      data: { userId: user.id, roleId: created.id, companyId: companyA },
    });

    // B's chain, instance and one decision — viewable under ATTENDANCE.
    ids.chain = `${companyB}-chain`;
    await admin.$executeRawUnsafe(
      `INSERT INTO "shared"."ApprovalChain" ("id","companyId","actionType","isFinalAuthorityRequired","isActive","createdAt","updatedAt")
       VALUES ($1,$2,$3,false,true,NOW(),NOW())`,
      ids.chain,
      companyB,
      entityType,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "shared"."ApprovalLevel" ("id","chainId","companyId","position","slotKey","isFinalAuthority","createdAt","updatedAt")
       VALUES ($1,$2,$3,1,'hr',false,NOW(),NOW())`,
      `${ids.chain}-l1`,
      ids.chain,
      companyB,
    );
    ids.instance = `${companyB}-inst`;
    await admin.$executeRawUnsafe(
      `INSERT INTO "shared"."ApprovalInstance" ("id","companyId","chainId","entityType","entityId","subject","viewPermission","currentPosition","state","originatorUserId","round","returnCount","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'E2E selected company','ATTENDANCE',1,'pending',$6,1,0,NOW(),NOW())`,
      ids.instance,
      companyB,
      ids.chain,
      entityType,
      entityId,
      user.id,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "shared"."ApprovalDecision" ("id","approvalInstanceId","companyId","round","position","actorUserId","action","reason","decidedAt")
       VALUES ($1,$2,$3,1,1,$4,'return','E2E reason',NOW())`,
      `${ids.instance}-dec`,
      ids.instance,
      companyB,
      user.id,
    );

    // The application itself, connected as the probe.
    process.env.DATABASE_URL = probeUrl(adminUrl);
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    process.env.DATABASE_URL = adminUrl;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!admin) return;
    const del = (sql: string, ...args: unknown[]) =>
      admin.$executeRawUnsafe(sql, ...args).catch(() => undefined);
    await del(
      `DELETE FROM "shared"."ApprovalDecision" WHERE "companyId" = $1`,
      companyB,
    );
    await del(
      `DELETE FROM "shared"."ApprovalInstance" WHERE "companyId" = $1`,
      companyB,
    );
    await del(
      `DELETE FROM "shared"."ApprovalLevel" WHERE "companyId" = $1`,
      companyB,
    );
    await del(
      `DELETE FROM "shared"."ApprovalChain" WHERE "companyId" = $1`,
      companyB,
    );
    // The superuser bypasses RLS, so the client's own deletes reach every row.
    if (ids.user) {
      const userId = ids.user;
      await admin.userCompanySelection.deleteMany({ where: { userId } });
      await admin.refreshToken.deleteMany({ where: { accountId: userId } });
      await admin.auditLogEntry.deleteMany({ where: { accountId: userId } });
      await admin.userRole.deleteMany({ where: { userId } });
      await admin.user.deleteMany({ where: { id: userId } });
    }
    if (ids.role) {
      await admin.rolePermission.deleteMany({ where: { roleId: ids.role } });
      await admin.role.deleteMany({ where: { id: ids.role } });
    }
    await del(`DELETE FROM "settings"."Company" WHERE "id" = ANY($1::text[])`, [
      companyA,
      companyB,
    ]);
    await admin.$disconnect();
  });

  it("returns B's approval history to a Super Admin homed in A who has selected B", async () => {
    if (!canProbe || !app) return;
    const http = () => request(app!.getHttpServer());
    const login = await http()
      .post('/auth/login')
      .send({ identifier: email, password: 'secret42', rememberMe: false })
      .expect(201);
    const token = login.body.accessToken as string;
    const auth = { Authorization: `Bearer ${token}` };

    await http()
      .put('/my/company-selection')
      .set(auth)
      .send({ companyId: companyB })
      .expect(200);

    const res = await http()
      .get(`/approvals/${entityType}/${entityId}/history`)
      .set(auth)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].reason).toBe('E2E reason');
  });
});
