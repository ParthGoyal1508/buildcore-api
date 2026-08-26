import { PrismaClient } from '@prisma/client';
import { hash } from 'argon2';

const prisma = new PrismaClient();

async function main() {
  await prisma.user.deleteMany();

  console.log('Seeding...');

  const password = await hash('secret42');

  const admin = await prisma.user.create({
    data: {
      email: 'admin@buildcore.dev',
      firstname: 'Super',
      lastname: 'Admin',
      role: 'ADMIN',
      password,
    },
  });

  const user = await prisma.user.create({
    data: {
      email: 'user@buildcore.dev',
      firstname: 'Test',
      lastname: 'User',
      role: 'USER',
      password,
    },
  });

  console.log({ admin, user });
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
