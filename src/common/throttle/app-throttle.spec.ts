import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { UseGuards } from '@nestjs/common';
import * as request from 'supertest';

import {
  AppThrottlerGuard,
  ExportThrottle,
  throttlersFor,
} from './app-throttle';

@Controller()
class ProbeController {
  @Get('plain') plain() {
    return 'ok';
  }
  @Get('other') other() {
    return 'ok';
  }
  @Get('export') @ExportThrottle() exp() {
    return 'ok';
  }
  @Get('auth')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  auth() {
    return 'ok';
  }
}

describe('app-wide throttling (036 B9)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot(
          throttlersFor({
            ttlSeconds: 60,
            limit: 3,
            appLimit: 6,
            appTtlSeconds: 60,
            exportLimit: 2,
            exportTtlSeconds: 60,
          }),
        ),
      ],
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(() => app.close());

  it('does not apply the auth limit to ordinary routes', async () => {
    // `default` is 3 here; an ordinary route must get past it.
    for (let i = 0; i < 5; i++) await http().get('/plain').expect(200);
  });

  it('counts every route against one per-address bucket', async () => {
    for (let i = 0; i < 3; i++) await http().get('/plain').expect(200);
    for (let i = 0; i < 3; i++) await http().get('/other').expect(200);
    await http().get('/other').expect(429);
  });

  it('holds exports to their own tighter limit', async () => {
    await http().get('/export').expect(200);
    await http().get('/export').expect(200);
    await http().get('/export').expect(429);
    await http().get('/plain').expect(200);
  });

  it('keeps a route’s own stricter @Throttle', async () => {
    await http().get('/auth').expect(200);
    await http().get('/auth').expect(200);
    await http().get('/auth').expect(429);
  });
});
