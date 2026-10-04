import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect({ service: 'buildcore-api', status: 'ok' });
  });

  // Releases the database pool. Added 2026-10-04: 19 of the 33 e2e suites never closed
  // their app, and `app.close()` alone was not enough either — `PrismaService` has no
  // `onModuleDestroy`, so `PrismaShutdownService` had to be added to make closing work.
  // Together these are why the suites could not all run in one go: Postgres refused new
  // connections part-way through, 158 failures with no product defect behind any of them.
  afterAll(async () => {
    await app.close();
  });
});
