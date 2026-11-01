/**
 * Generates a new App Settings password and prints it once (054, 2026-11-01).
 *
 * App Settings is confirmed with this password, not anybody's sign-in password, and there is no
 * screen that sets or shows it: this script is the only way to change it. Each run replaces the
 * previous password, which stops working at once. Only the argon2 hash is stored — the password
 * printed here cannot be recovered later, so pass it on before closing the terminal.
 *
 * Usage (from the repo root):
 *
 *   DATABASE_URL="<target database url>" npx ts-node prisma/rotate-settings-password.ts
 */
import { randomInt } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { hash } from 'argon2';

const PURPOSE = 'cash-visibility';
// No 0/O, 1/l/I: it is read off a screen and typed in by hand.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generate(): string {
  const group = () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
      '',
    );
  return [group(), group(), group()].join('-');
}

async function main() {
  const prisma = new PrismaClient();
  const password = generate();
  const hashed = await hash(password);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_super_admin', 'true', true)`;
      await tx.confirmationSecret.upsert({
        where: { purpose: PURPOSE },
        create: { purpose: PURPOSE, hash: hashed },
        update: { hash: hashed, rotatedAt: new Date() },
      });
    });
  } finally {
    await prisma.$disconnect();
  }
  console.log(`New App Settings password: ${password}`);
  console.log('The previous one no longer works. It is not shown again.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
