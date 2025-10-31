import { prisma } from './prisma';
import { createLogger, toError } from './logger';

const log = createLogger('ManualCallPoints');

export async function recordManualCallPointActivation(zoneId: string): Promise<void> {
  try {
    const existing = await prisma.manualCallPoint.findFirst({ where: { zoneId } });
    const data = { isLatched: true, lastActivatedAt: new Date() };
    if (existing) {
      await prisma.manualCallPoint.update({ where: { id: existing.id }, data });
    } else {
      await prisma.manualCallPoint.create({ data: { zoneId, ...data } });
    }
  } catch (error) {
    log.error("Échec de l'enregistrement de l'activation du DM", {
      zoneId,
      error: toError(error),
    });
  }
}

export async function recordManualCallPointReset(zoneId: string): Promise<boolean> {
  try {
    const updated = await prisma.manualCallPoint.updateMany({
      where: { zoneId },
      data: { isLatched: false, lastResetAt: new Date() },
    });
    return updated.count > 0;
  } catch (error) {
    log.error("Échec de l'enregistrement du réarmement du DM", {
      zoneId,
      error: toError(error),
    });
    return false;
  }
}
