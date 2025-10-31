import http from 'http';
import { createHttpServer } from './app';
import { createDomainContext } from './state';
import { ensureSeeds, prisma } from './prisma';
import { SessionManager } from './session-manager';

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
    // eslint-disable-next-line no-console
    console.log(`Server listening on port ${port}`);
  });
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  prisma.$disconnect().finally(() => process.exit(1));
});
