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
  const prismaAny = prisma as unknown as {
    accessCode: {
      upsert(args: { where: { level: number }; update: { code?: string }; create: { level: number; code: string } }): Promise<unknown>;
    };
  };
  await prismaAny.accessCode.upsert({
    where: { level: 2 },
    update: {},
    create: { level: 2, code: '2222' },
  });
  await prismaAny.accessCode.upsert({
    where: { level: 3 },
    update: {},
    create: { level: 3, code: '3333' },
  });
}
