import { PrismaShutdownService } from './prisma-shutdown.service';

/**
 * The connection pool is released on shutdown, and a failure to release it does not
 * replace the reason the process was shutting down.
 *
 * Both assertions are about the end-to-end harness rather than about production. See the
 * service's own docblock: `nestjs-prisma`'s `PrismaService` has no `onModuleDestroy`, so
 * before this existed `app.close()` left the pool open and 33 suites exhausted a
 * 100-connection server part-way through.
 */
describe('PrismaShutdownService', () => {
  it('disconnects the client when the module is destroyed', async () => {
    const prisma = { $disconnect: jest.fn().mockResolvedValue(undefined) };
    const service = new PrismaShutdownService(prisma as never);

    await service.onModuleDestroy();

    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the disconnect itself fails', async () => {
    const prisma = {
      $disconnect: jest.fn().mockRejectedValue(new Error('already closed')),
    };
    const service = new PrismaShutdownService(prisma as never);

    // A throw here would surface during shutdown and bury whatever caused it — the
    // database being gone is a common reason to be shutting down in the first place.
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
