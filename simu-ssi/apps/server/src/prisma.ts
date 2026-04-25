import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function ensureSeeds() {
  await prisma.siteConfig.upsert({
    where: { id: 1 },
    update: {},
    create: {},
  });
  await prisma.processAck.upsert({
    where: { id: 1 },
    update: {},
    create: {},
  });

  await prisma.accessCode.upsert({
    where: { level: 2 },
    update: {},
    create: { level: 2, codeHash: null },
  });
  await prisma.accessCode.upsert({
    where: { level: 3 },
    update: {},
    create: { level: 3, codeHash: null },
  });
}
