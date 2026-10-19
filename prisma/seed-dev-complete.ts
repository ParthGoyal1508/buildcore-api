/**
 * Completes an already-seeded develop database: runs every module in `prisma/seed-dev/` for each
 * company, in dependency order. Idempotent — each module skips what is already there.
 *
 *   npm run seed:dev:complete                       # local database from DATABASE_URL
 *   SEED_DEV_ONLY=hr,payroll npm run seed:dev:complete   # just those modules
 *
 * Aim it at a remote host only on purpose (SEED_DEV_ALLOW_HOST=<host>); the production host is
 * refused outright. See prisma/seed-dev/support.ts for the rules every module follows.
 */
import 'dotenv/config';

import { assertSeedTarget } from './seed-dev/support';

// Before the client is built: a remote target pins DATABASE_URL to one connection.
const TARGET = assertSeedTarget('seed-dev-complete.ts');

import { PrismaClient } from '@prisma/client';

import { runCompletion } from './seed-dev/run';

const prisma = new PrismaClient();

runCompletion(prisma, {
  only: process.env.SEED_DEV_ONLY?.split(',').map((s) => s.trim()),
  label: TARGET.isLocal ? 'local' : TARGET.host,
})
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
