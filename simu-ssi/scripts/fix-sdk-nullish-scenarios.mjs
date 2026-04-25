#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sdkPath = resolve(process.cwd(), 'packages/sdk/src/index.ts');
let source = readFileSync(sdkPath, 'utf8');
let changed = false;

function replaceAll(searchValue, replaceValue, label) {
  if (!source.includes(searchValue)) {
    console.warn(`Skipped missing anchor: ${label}`);
    return;
  }
  const before = source;
  source = source.split(searchValue).join(replaceValue);
  if (source !== before) {
    changed = true;
    console.log(`Updated: ${label}`);
  }
}

replaceAll('const scenarioTopologySchema = topologySchema.optional();', 'const scenarioTopologySchema = topologySchema.nullish();', 'scenario topology schema');
replaceAll('export const scenarioEvacuationAudioSchema = scenarioEvacuationAudioInnerSchema.optional();', 'export const scenarioEvacuationAudioSchema = scenarioEvacuationAudioInnerSchema.nullish();', 'scenario evacuation audio schema');
replaceAll('description: z.string().optional(),', 'description: z.string().nullish(),', 'nullable descriptions');
replaceAll('label: z.string().optional(),', 'label: z.string().nullish(),', 'nullable scenario event labels');
replaceAll('reason: z.string().optional()', 'reason: z.string().nullish()', 'nullable manual evacuation reason');
replaceAll('ackedBy: z.string().optional()', 'ackedBy: z.string().nullish()', 'nullable process ack author');
replaceAll('manualResettable: scenarioManualResetSelectionSchema.optional(),', 'manualResettable: scenarioManualResetSelectionSchema.nullish(),', 'nullable manual reset selection');
replaceAll('scenario: scenarioDefinitionSchema.optional(),', 'scenario: scenarioDefinitionSchema.nullish(),', 'nullable runner scenario');

// Keep topology and devices tolerant with payloads serialized from SQLite/JSON columns.
replaceAll('zoneId: z.string().min(1).optional(),', 'zoneId: z.string().min(1).nullish(),', 'nullable device zoneId');
replaceAll('props: z.record(z.unknown()).optional(),', 'props: z.record(z.unknown()).nullish(),', 'nullable device props');
replaceAll('outOfService: z.boolean().optional(),', 'outOfService: z.boolean().nullish(),', 'nullable device outOfService');
replaceAll('name: z.string().min(1).optional(),', 'name: z.string().min(1).nullish(),', 'nullable plan name');
replaceAll('notes: z.string().optional(),', 'notes: z.string().nullish(),', 'nullable plan notes');

if (!changed) {
  console.log('SDK scenario schemas already accept nullable persisted fields.');
  process.exit(0);
}

writeFileSync(sdkPath, source, 'utf8');
console.log('SDK scenario schemas now accept nullable persisted fields.');
