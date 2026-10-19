import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';

/**
 * The invite token is the only credential on these routes, so the rate limit is what stands
 * between them and a token-guessing oracle. `@Throttle` alone does nothing without a guard to
 * enforce it — every request was answered until 036 B1 attached one.
 */
describe('InvitesController rate limit', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      // A generous module default, so only the route's own @Throttle can be what refuses.
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [InvitesController],
      providers: [
        {
          provide: InvitesService,
          useValue: {
            validate: jest.fn().mockResolvedValue({ valid: false }),
            setPassword: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(() => app.close());

  it('refuses the 11th invite check in a minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await request(app.getHttpServer()).get(
            '/account-creation/invites/abc',
          )
        ).status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('refuses the 6th set-password attempt in a minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (
          await request(app.getHttpServer())
            .post('/account-creation/invites/abc/set-password')
            .send({ password: 'Irrelevant-1' })
        ).status,
      );
    }
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
