#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sdkPath = resolve(process.cwd(), 'packages/sdk/src/index.ts');
let source = readFileSync(sdkPath, 'utf8');
let changed = false;

function replaceOnce(before, after, label) {
  if (!source.includes(before)) {
    if (source.includes(after)) {
      console.log(`Already patched: ${label}`);
      return;
    }
    throw new Error(`Missing SDK anchor: ${label}`);
  }
  source = source.replace(before, after);
  changed = true;
}

replaceOnce(
  'const scenarioTopologySchema = topologySchema.optional();',
  'const scenarioTopologySchema = topologySchema.nullish().transform((value) => value ?? undefined);',
  'scenario topology nullable normalization',
);

replaceOnce(
  'export const scenarioEvacuationAudioSchema = scenarioEvacuationAudioInnerSchema.optional();',
  'export const scenarioEvacuationAudioSchema = scenarioEvacuationAudioInnerSchema.nullish().transform((value) => value ?? undefined);',
  'scenario evacuation audio nullable normalization',
);

replaceOnce(
  '  manualResettable: scenarioManualResetSelectionSchema.optional(),',
  '  manualResettable: scenarioManualResetSelectionSchema.nullish().transform((value) => value ?? undefined),',
  'scenario definition manualResettable nullable normalization',
);

replaceOnce(
  '  manualResettable: scenarioManualResetSelectionSchema.optional(),\n  evacuationAudio: scenarioEvacuationAudioSchema,',
  '  manualResettable: scenarioManualResetSelectionSchema.nullish().transform((value) => value ?? undefined),\n  evacuationAudio: scenarioEvacuationAudioSchema,',
  'scenario payload manualResettable nullable normalization',
);

if (!changed) {
  console.log('SDK nullable scenario fields are already normalized.');
  process.exit(0);
}

writeFileSync(sdkPath, source, 'utf8');
console.log('SDK nullable scenario fields normalized.');
