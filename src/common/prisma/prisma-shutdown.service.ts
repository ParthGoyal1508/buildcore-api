import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

/**
 * Closes the database connection pool when the Nest application shuts down.
 *
 * ## Why this file exists
 *
 * `nestjs-prisma`'s `PrismaService` implements `OnModuleInit` and **nothing else** — read
 * its `.d.ts`: `implements OnModuleInit`. There is no `onModuleDestroy`, so `app.close()`
 * tears down every Nest provider and leaves the Prisma pool open. In a server that is
 * nearly harmless, because the process exits a moment later. In a test run it is the
 * difference between a suite that passes and a suite that cannot connect.
 *
 * Found on 2026-10-04 while fixing the end-to-end harness. Running all 33 suites together
 * produced 158 failures that had nothing to do with the product: Postgres refusing new
 * connections part-way through, with `max_connections` at 100 and Prisma's default pool
 * sized from the CPU count. Nineteen of the suites never called `app.close()` at all,
 * which was the obvious half of the cause — and fixing only that would not have worked,
 * because **the fourteen suites that did close their app were leaking too.** The proof
 * that the obvious fix was insufficient is in this type signature.
 *
 * Registered in `AppModule` rather than wrapped around `PrismaService`, so nothing about
 * how the rest of the application obtains the client changes.
 */
@Injectable()
export class PrismaShutdownService implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaShutdownService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.prisma.$disconnect();
    } catch (error) {
      // Swallowed deliberately. This runs during shutdown, and a throw here replaces
      // whatever caused the shutdown with a disconnect error — losing the reason the
      // process was going down in the first place.
      this.logger.warn(
        `Disconnecting Prisma on shutdown failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
