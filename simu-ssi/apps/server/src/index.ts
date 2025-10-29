import http from 'http';
import { createHttpServer } from './app';
import { createDomainContext } from './state';
import { ensureSeeds, prisma } from './prisma';

async function bootstrap() {
  await ensureSeeds();
  const domainContext = await createDomainContext();
  const { server } = createHttpServer(domainContext);
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
