#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const clientFiles = [
  'apps/trainer-console/src/pages/App.tsx',
  'apps/trainee-station/src/pages/TraineeApp.tsx',
  'apps/admin-studio/src/pages/AdminStudioApp.tsx',
];

const helpers = `
function getConfiguredApiToken(): string | undefined {
  const token = import.meta.env.VITE_SIMU_SSI_API_TOKEN;
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : undefined;
}

function createSocketOptions() {
  const token = getConfiguredApiToken();
  return token ? { auth: { token } } : undefined;
}
`;

function patchClient(source, relativePath) {
  let out = source;

  if (!out.includes('function getConfiguredApiToken()')) {
    const sdkImportPattern = /} from '@simu-ssi\/sdk';\n/;
    if (!sdkImportPattern.test(out)) {
      throw new Error(`Unable to insert client auth helpers in ${relativePath}: SDK import anchor not found.`);
    }
    out = out.replace(sdkImportPattern, (match) => `${match}${helpers}\n`);
  }

  out = out.replace(/new SsiSdk\(([^\n,()]+)\)/g, (match, baseUrlExpression) => {
    if (match.includes('getConfiguredApiToken')) {
      return match;
    }
    return `new SsiSdk(${baseUrlExpression.trim()}, { apiToken: getConfiguredApiToken() })`;
  });

  // Patch only direct Socket.IO calls, never identifiers ending with "io" such as scenario/audio.
  out = out.replace(/(?<![A-Za-z0-9_$])io\(([^\n)]*)\)/g, (match, args) => {
    if (match.includes('createSocketOptions')) {
      return match;
    }
    return `io(${args}, createSocketOptions())`;
  });

  // Repair known false positives if an older broad regex ever touched these files.
  out = out.replace(/normalizeEvacuationAudio\(([^\n;]*?),\s*createSocketOptions\(\)\)/g, 'normalizeEvacuationAudio($1)');
  out = out.replace(/sanitizeAudioAsset\(([^\n;]*?),\s*createSocketOptions\(\)\)/g, 'sanitizeAudioAsset($1)');
  out = out.replace(/setDraftScenario\(([^\n;]*?),\s*createSocketOptions\(\)\)/g, 'setDraftScenario($1)');
  out = out.replace(/sdk\.([A-Za-z0-9_]+)\(([^\n;]*?),\s*createSocketOptions\(\)\)/g, 'sdk.$1($2)');
  out = out.replace(/\(,\s*createSocketOptions\(\)\)/g, '()');
  out = out.replace(/\(prev,\s*createSocketOptions\(\)\)/g, '(prev)');

  if (out.includes('new SsiSdk(baseUrl)')) {
    throw new Error(`Unpatched SDK constructor remains in ${relativePath}.`);
  }

  return out;
}

let changed = false;

for (const relativePath of clientFiles) {
  const path = resolve(root, relativePath);
  if (!existsSync(path)) {
    console.warn(`Skipped missing file: ${relativePath}`);
    continue;
  }
  const before = readFileSync(path, 'utf8');
  const after = patchClient(before, relativePath);
  if (after !== before) {
    writeFileSync(path, after, 'utf8');
    console.log(`Updated: ${relativePath}`);
    changed = true;
  } else {
    console.log(`No change: ${relativePath}`);
  }
}

if (!changed) {
  console.log('All client apps already propagate the API token.');
}
