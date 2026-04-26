#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const filePath = resolve(process.cwd(), 'apps/admin-studio/src/pages/AdminStudioApp.tsx');
let source = readFileSync(filePath, 'utf8');
let changed = false;

function replaceOnce(before, after, label) {
  if (!source.includes(before)) {
    if (source.includes(after)) {
      console.log(`Already patched: ${label}`);
      return;
    }
    throw new Error(`Missing anchor: ${label}`);
  }
  source = source.replace(before, after);
  changed = true;
}

replaceOnce(
  `        if (xPercent === undefined || yPercent === undefined) {\n          warnings.push(\`Dispositif «\\u00a0\${device.id}\\u00a0» ignoré (coordonnées manquantes).\`);\n          continue;\n        }\n\n        deviceCounts[device.kind] += 1;`,
  `        deviceCounts[device.kind] += 1;`,
  'do not ignore devices without coordinates',
);

replaceOnce(
  `          xPercent,\n          yPercent,`,
  `          xPercent: typeof xPercent === 'number' ? xPercent : 50,\n          yPercent: typeof yPercent === 'number' ? yPercent : 50,`,
  'fallback coordinates for unplaced devices',
);

replaceOnce(
  `        if (device.zoneId && !zoneId) {\n          warnings.push(\`Zone «\\u00a0\${device.zoneId}\\u00a0» introuvable pour le dispositif «\\u00a0\${device.id}\\u00a0».\`);\n        }\n\n        importedDevices.push({`,
  `        if (device.zoneId && !zoneId) {\n          warnings.push(\`Zone «\\u00a0\${device.zoneId}\\u00a0» introuvable pour le dispositif «\\u00a0\${device.id}\\u00a0».\`);\n        }\n        if (xPercent === undefined || yPercent === undefined) {\n          warnings.push(\`Dispositif «\\u00a0\${device.id}\\u00a0» placé provisoirement au centre du plan (coordonnées manquantes).\`);\n        }\n\n        importedDevices.push({`,
  'warn about provisional center placement',
);

if (!changed) {
  console.log('Admin unplaced devices behavior already patched.');
  process.exit(0);
}

writeFileSync(filePath, source, 'utf8');
console.log('Admin unplaced devices behavior patched.');
