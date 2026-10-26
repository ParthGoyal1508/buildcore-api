import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/configure-app';
import { withRlsContext } from '../src/common/prisma/rls-context';

/**
 * A `companyId` naming no company is refused (2026-10-25). Before, a cross-company caller's
 * `POST /projects/sites?companyId=undefined` saved a site in a company called "undefined".
 */
const NAME = `E2ERC Site ${Date.now() % 100000}`;

describe('Requested company (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        identifier: 'admin@buildcore.dev',
        password: 'secret42',
        rememberMe: false,
      })
      .expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
      tx.site.deleteMany({ where: { name: NAME } }),
    );
    await app.close();
  });

  it('refuses a site for a company that does not exist, and saves nothing', async () => {
    const res = await request(app.getHttpServer())
      .post('/projects/sites?companyId=undefined')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        name: NAME,
        latitude: 19.076,
        longitude: 72.8777,
        geofenceRadiusMeters: 200,
        weeklyOffDay: 0,
      })
      .expect(400);
    expect(res.body.code).toBe('UNKNOWN_COMPANY');
    const saved = await withRlsContext(prisma, { isSuperAdmin: true }, (tx) =>
      tx.site.count({ where: { name: NAME } }),
    );
    expect(saved).toBe(0);
  });
});
