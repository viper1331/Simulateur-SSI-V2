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
  `const createDeviceId = (kind: DeviceKind) => {\n  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {\n    return \`${'${kind}'}-${'${crypto.randomUUID()}'}\`;\n  }\n  return \`${'${kind}'}-${'${Date.now()}'}-${'${Math.round(Math.random() * 1000)}'}\`;\n};`,
  `const createDeviceId = (kind: DeviceKind) => {\n  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {\n    return \`${'${kind}'}-${'${crypto.randomUUID()}'}\`;\n  }\n  return \`${'${kind}'}-${'${Date.now()}'}-${'${Math.round(Math.random() * 1000)}'}\`;\n};\n\nfunction getFallbackDeviceCoordinates(index: number, total: number) {\n  const columns = Math.max(1, Math.ceil(Math.sqrt(total)));\n  const rows = Math.max(1, Math.ceil(total / columns));\n  const column = index % columns;\n  const row = Math.floor(index / columns);\n  return {\n    xPercent: parseFloat((((column + 1) / (columns + 1)) * 100).toFixed(2)),\n    yPercent: parseFloat((((row + 1) / (rows + 1)) * 100).toFixed(2)),\n  };\n}`,
  'fallback coordinate helper',
);

replaceOnce(
  `      const importedDevices: DevicePlacement[] = [];\n      for (const device of topology.devices ?? []) {`,
  `      const sourceDevices = topology.devices ?? [];\n      const unplacedDevices = sourceDevices.filter((device) => {\n        const coordinates = (device.props?.coordinates as { xPercent?: number; yPercent?: number } | undefined) ?? {};\n        return typeof coordinates.xPercent !== 'number' || typeof coordinates.yPercent !== 'number';\n      });\n      let unplacedIndex = 0;\n\n      const importedDevices: DevicePlacement[] = [];\n      for (const device of sourceDevices) {`,
  'prepare unplaced device count',
);

replaceOnce(
  `        importedDevices.push({\n          id: device.id,\n          kind: device.kind,\n          label,\n          xPercent: typeof xPercent === 'number' ? xPercent : 50,\n          yPercent: typeof yPercent === 'number' ? yPercent : 50,\n          zoneId,\n        });`,
  `        const fallbackCoordinates =\n          xPercent === undefined || yPercent === undefined\n            ? getFallbackDeviceCoordinates(unplacedIndex++, unplacedDevices.length)\n            : null;\n\n        importedDevices.push({\n          id: device.id,\n          kind: device.kind,\n          label,\n          xPercent: typeof xPercent === 'number' ? xPercent : fallbackCoordinates?.xPercent ?? 50,\n          yPercent: typeof yPercent === 'number' ? yPercent : fallbackCoordinates?.yPercent ?? 50,\n          zoneId,\n        });`,
  'grid fallback placement',
);

if (!changed) {
  console.log('Admin unplaced devices grid behavior already patched.');
  process.exit(0);
}

writeFileSync(filePath, source, 'utf8');
console.log('Admin unplaced devices grid behavior patched.');
