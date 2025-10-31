import http from 'http';
import { createHttpServer } from './app';
import { createDomainContext } from './state';
import { ensureSeeds, prisma } from './prisma';
import { SessionManager } from './session-manager';
import { logger } from './logger';

const log = logger.child('bootstrap');

async function bootstrap() {
  await ensureSeeds();
  const sessionManager = new SessionManager();
  await sessionManager.hydrate();
  const domainContext = await createDomainContext({
    getActiveSessionId: () => sessionManager.getActiveSessionId(),
  });
  const { server } = createHttpServer(domainContext, sessionManager);
  const port = process.env.PORT ? Number(process.env.PORT) : 4500;
  (server as http.Server).listen(port, () => {
    log.info('Server listening', { port });
  });
}

bootstrap().catch((err) => {
  log.error('Server failed to start', { error: err instanceof Error ? err : new Error(String(err)) });
  prisma.$disconnect().finally(() => process.exit(1));
});
