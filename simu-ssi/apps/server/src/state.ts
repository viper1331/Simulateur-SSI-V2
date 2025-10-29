import { createSsiDomain, DomainSnapshot } from '@simu-ssi/domain-ssi';
import { prisma } from './prisma';

export interface DomainContext {
  snapshot(): DomainSnapshot;
  domain: ReturnType<typeof createSsiDomain>;
  refreshConfig(): Promise<void>;
}

export async function createDomainContext(): Promise<DomainContext> {
  const siteConfig = await prisma.siteConfig.findUniqueOrThrow({ where: { id: 1 } });
  const domain = createSsiDomain({
    evacOnDmDelayMs: siteConfig.evacOnDMDelayMs,
    processAckRequired: siteConfig.processAckRequired,
  });

  domain.emitter.on('events.append', async (event) => {
    await prisma.eventLog.create({
      data: {
        source: event.source,
        payloadJson: event.details ? JSON.stringify(event.details) : null,
      },
    });
  });

  return {
    domain,
    snapshot: () => domain.snapshot,
    async refreshConfig() {
      const config = await prisma.siteConfig.findUniqueOrThrow({ where: { id: 1 } });
      domain.updateConfig({
        evacOnDmDelayMs: config.evacOnDMDelayMs,
        processAckRequired: config.processAckRequired,
      });
    },
  };
}
