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
}
