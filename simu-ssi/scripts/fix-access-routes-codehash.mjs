#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appPath = resolve(process.cwd(), 'apps/server/src/app.ts');
let source = readFileSync(appPath, 'utf8');
let changed = false;

function replace(searchValue, replaceValue, label) {
  if (!source.includes(searchValue)) {
    console.warn(`Skipped missing anchor: ${label}`);
    return false;
  }
  source = source.replace(searchValue, replaceValue);
  changed = true;
  return true;
}

function replaceRange(startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    console.warn(`Skipped missing start marker: ${label}`);
    return false;
  }
  const end = source.indexOf(endMarker, start);
  if (end === -1) {
    console.warn(`Skipped missing end marker: ${label}`);
    return false;
  }
  source = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
  changed = true;
  return true;
}

replace(
  "import { randomUUID } from 'node:crypto';",
  "import { createHash, randomUUID } from 'node:crypto';",
  'crypto import',
);

if (!source.includes('function hashAccessCode(')) {
  replace(
    `const accessCodeVerifySchema = z.object({\n  code: z.string().max(32),\n});`,
    `const accessCodeVerifySchema = z.object({\n  code: z.string().max(32),\n});\n\nfunction hashAccessCode(code: string): string {\n  return createHash('sha256').update(code, 'utf8').digest('hex');\n}\n\nfunction formatAccessCode(row: { level: number; codeHash: string | null; updatedAt: Date | string }) {\n  return {\n    level: Number(row.level),\n    code: row.codeHash ? '••••' : 'Non configuré',\n    updatedAt: new Date(row.updatedAt).toISOString(),\n  };\n}`,
    'access code helpers',
  );
}

replaceRange(
  "  app.get('/api/access/codes'",
  "  app.post('/api/access/verify'",
  `  app.get('/api/access/codes', async (_req, res) => {\n    const rows = await prisma.accessCode.findMany({ orderBy: { level: 'asc' } });\n    const codes = rows.map(formatAccessCode);\n    log.debug(\"Codes d'accès renvoyés\", { count: codes.length });\n    res.json({ codes });\n  });\n\n  app.put('/api/access/codes/:level', async (req, res) => {\n    const level = Number(req.params.level);\n    if (!Number.isFinite(level) || level < 1 || level > 3) {\n      return res.status(400).json({ error: 'INVALID_LEVEL' });\n    }\n    const parsed = accessCodeUpdateSchema.safeParse(req.body);\n    if (!parsed.success) {\n      return res.status(400).json({ error: parsed.error.message });\n    }\n    const code = parsed.data.code.trim();\n    const codeHash = hashAccessCode(code);\n    const duplicate = await prisma.accessCode.findFirst({\n      where: {\n        codeHash,\n        level: { not: level },\n      },\n      select: { level: true },\n    });\n    if (duplicate) {\n      return res.status(409).json({ error: 'CODE_ALREADY_IN_USE' });\n    }\n    const record = await prisma.accessCode.upsert({\n      where: { level },\n      update: { codeHash },\n      create: { level, codeHash },\n    });\n    log.info(\"Code d'accès mis à jour\", { level });\n    res.json({ code: formatAccessCode(record) });\n  });\n\n`,
  'access code GET/PUT routes',
);

const rawLookupStart = `    const rows = await prisma.$queryRaw<Array<{ level: number }>>\`\n      SELECT level FROM \"AccessCode\" WHERE code = \${input} LIMIT 1\n    \`;`;
const rawLookupEnd = `    const level = Number(rows[0].level);`;
const rawStart = source.indexOf(rawLookupStart);
if (rawStart !== -1) {
  const rawEnd = source.indexOf(rawLookupEnd, rawStart);
  if (rawEnd === -1) {
    console.warn('Skipped missing verify lookup end marker');
  } else {
    const afterEnd = rawEnd + rawLookupEnd.length;
    source = `${source.slice(0, rawStart)}    const record = await prisma.accessCode.findFirst({\n      where: { codeHash: hashAccessCode(input) },\n      select: { level: true },\n    });\n    if (!record) {\n      log.debug(\"Code d'accès refusé\", { reason: 'unknown-code' });\n      return res.json({ level: null, allowed: false, label: 'Code invalide — niveau courant conservé.' });\n    }\n    const level = Number(record.level);${source.slice(afterEnd)}`;
    changed = true;
  }
} else {
  console.warn('Skipped missing verify raw code lookup');
}

if (source.includes('SELECT level, code') || source.includes('WHERE code =') || source.includes('"level", "code"')) {
  throw new Error('AccessCode routes still reference the legacy code column.');
}

if (!changed) {
  console.log('No changes applied.');
  process.exit(0);
}

writeFileSync(appPath, source, 'utf8');
console.log('Access code routes patched to use codeHash.');
