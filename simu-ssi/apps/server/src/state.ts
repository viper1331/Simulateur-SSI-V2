import { createSsiDomain, DomainSnapshot } from '@simu-ssi/domain-ssi';
import { prisma } from './prisma';
import { createLogger, toError } from './logger';

const log = createLogger('DomainState');

export interface DomainContextOptions {
  getActiveSessionId?: () => string | null;
}

export interface DomainContext {
  snapshot(): DomainSnapshot;
  domain: ReturnType<typeof createSsiDomain>;
  refreshConfig(): Promise<void>;
}

export async function createDomainContext(options: DomainContextOptions = {}): Promise<DomainContext> {
  const siteConfig = await prisma.siteConfig.findUniqueOrThrow({ where: { id: 1 } });
  const domain = createSsiDomain({
    evacOnDmDelayMs: siteConfig.evacOnDMDelayMs,
    processAckRequired: siteConfig.processAckRequired,
    evacOnDai: siteConfig.evacOnDAI,
  });

  log.info("Contexte de domaine initialisé", {
    evacOnDmDelayMs: siteConfig.evacOnDMDelayMs,
    processAckRequired: siteConfig.processAckRequired,
    evacOnDai: siteConfig.evacOnDAI,
  });

  domain.emitter.on('events.append', async (event) => {
    try {
      await prisma.eventLog.create({
        data: {
          source: event.source,
          payloadJson: event.details ? JSON.stringify(event.details) : null,
          sessionId: options.getActiveSessionId ? options.getActiveSessionId() ?? undefined : undefined,
        },
      });
      log.debug("Événement de domaine enregistré", {
        source: event.source,
        hasDetails: Boolean(event.details),
      });
    } catch (error) {
      log.error("Échec de l'enregistrement de l'événement de domaine", {
        error: toError(error),
        source: event.source,
      });
    }
  });

  return {
    domain,
    snapshot: () => domain.snapshot,
    async refreshConfig() {
      const config = await prisma.siteConfig.findUniqueOrThrow({ where: { id: 1 } });
      domain.updateConfig({
        evacOnDmDelayMs: config.evacOnDMDelayMs,
        processAckRequired: config.processAckRequired,
        evacOnDai: config.evacOnDAI,
      });
      log.info("Configuration du domaine rafraîchie", {
        evacOnDmDelayMs: config.evacOnDMDelayMs,
        processAckRequired: config.processAckRequired,
        evacOnDai: config.evacOnDAI,
      });
    },
  };
}
