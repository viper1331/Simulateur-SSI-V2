#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const appPath = resolve(root, 'apps/server/src/app.ts');
let source = readFileSync(appPath, 'utf8');
let changed = false;

function ensureIncludes(needle, replacement, label) {
  if (source.includes(needle)) {
    return;
  }
  if (!source.includes(label)) {
    throw new Error(`Unable to find insertion anchor: ${label}`);
  }
  source = source.replace(label, replacement);
  changed = true;
}

ensureIncludes(
  "from './auth'",
  "import { createApiAuthMiddleware, createSocketAuthMiddleware, getAuthConfig } from './auth';\nimport { recordManualCallPointActivation, recordManualCallPointReset } from './manual-call-points';",
  "import { recordManualCallPointActivation, recordManualCallPointReset } from './manual-call-points';",
);

ensureIncludes(
  'const authConfig = getAuthConfig();',
  '  const log = httpLogger;\n  const authConfig = getAuthConfig();',
  '  const log = httpLogger;',
);

ensureIncludes(
  "app.use('/api', createApiAuthMiddleware(authConfig));",
  "  app.use('/api', createApiAuthMiddleware(authConfig));\n\n  const scenarioRunner = new ScenarioRunner(domainContext.domain, {",
  "  const scenarioRunner = new ScenarioRunner(domainContext.domain, {",
);

if (!source.includes('io.use(createSocketAuthMiddleware(authConfig));')) {
  const socketRegex = /(const io = new SocketIOServer\([\s\S]*?\);)/;
  if (!socketRegex.test(source)) {
    throw new Error('Unable to find Socket.IO server creation. Add io.use(createSocketAuthMiddleware(authConfig)) manually after SocketIOServer initialization.');
  }
  source = source.replace(socketRegex, `$1\n  io.use(createSocketAuthMiddleware(authConfig));`);
  changed = true;
}

if (!changed) {
  console.log('API auth is already integrated.');
  process.exit(0);
}

writeFileSync(appPath, source, 'utf8');
console.log('API auth middleware integrated in apps/server/src/app.ts');
