import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import { ConfigService } from '@nestjs/config';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PasswordService, PrismaService, ConfigService],
    }).compile();

    service = module.get<PasswordService>(PasswordService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

describe('PasswordService — missing stored hash (T029)', () => {
  const service = new PasswordService();

  // Feature 010 made User.password nullable for pending accounts, and login checks
  // the password before it checks status — so this path is reached in normal use.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('returns false rather than throwing for %s', async (_label, stored) => {
    await expect(
      service.validatePassword('anything', stored as never),
    ).resolves.toBe(false);
  });

  it('still verifies a real hash correctly', async () => {
    const hashed = await service.hashPassword('Password1');
    await expect(service.validatePassword('Password1', hashed)).resolves.toBe(
      true,
    );
    await expect(service.validatePassword('wrong', hashed)).resolves.toBe(
      false,
    );
  });
});
