#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appPath = resolve(process.cwd(), 'apps/server/src/app.ts');
let source = readFileSync(appPath, 'utf8');
let changed = false;

function replaceOnce(searchValue, replaceValue, label) {
  if (!source.includes(searchValue)) {
    console.warn(`Skipped missing anchor: ${label}`);
    return;
  }
  source = source.replace(searchValue, replaceValue);
  changed = true;
}

replaceOnce(
  "import { randomUUID } from 'node:crypto';",
  "import { createHash, randomUUID } from 'node:crypto';",
  'crypto import',
);

const helperAnchor = `const accessCodeVerifySchema = z.object({\n  code: z.string().max(32),\n});`;
const helperBlock = `const accessCodeVerifySchema = z.object({\n  code: z.string().max(32),\n});\n\nfunction hashAccessCode(code: string): string {\n  return createHash('sha256').update(code, 'utf8').digest('hex');\n}\n\nfunction formatAccessCode(row: { level: number; codeHash: string | null; updatedAt: Date | string }) {\n  return {\n    level: Number(row.level),\n    code: row.codeHash ? '••••' : 'Non configuré',\n    updatedAt: new Date(row.updatedAt).toISOString(),\n  };\n}`;

if (!source.includes('function hashAccessCode(')) {
  replaceOnce(helperAnchor, helperBlock, 'access code helpers');
}

const getRouteRegex = /  app\.get\('\/api\/access\/codes', async \(_req, res\) => \{[\s\S]*?  \}\);\n\n  app\.put\('\/api\/access\/codes\/:level'/;
const getRouteReplacement = `  app.get('/api/access/codes', async (_req, res) => {\n    const rows = await prisma.accessCode.findMany({ orderBy: { level: 'asc' } });\n    const codes = rows.map(formatAccessCode);\n    log.debug(\"Codes d'accès renvoyés\", { count: codes.length });\n    res.json({ codes });\n  });\n\n  app.put('/api/access/codes/:level'`;

if (getRouteRegex.test(source)) {
  source = source.replace(getRouteRegex, getRouteReplacement);
  changed = true;
} else {
  console.warn('Skipped missing route: GET /api/access/codes');
}

const putRouteRegex = /  app\.put\('\/api\/access\/codes\/:level', async \(req, res\) => \{[\s\S]*?  \}\);\n\n  app\.post\('\/api\/access\/verify'/;
const putRouteReplacement = `  app.put('/api/access/codes/:level', async (req, res) => {\n    const level = Number(req.params.level);\n    if (!Number.isFinite(level) || level < 1 || level > 3) {\n      return res.status(400).json({ error: 'INVALID_LEVEL' });\n    }\n    const parsed = accessCodeUpdateSchema.safeParse(req.body);\n    if (!parsed.success) {\n      return res.status(400).json({ error: parsed.error.message });\n    }\n    const code = parsed.data.code.trim();\n    const codeHash = hashAccessCode(code);\n    const duplicate = await prisma.accessCode.findFirst({\n      where: {\n        codeHash,\n        level: { not: level },\n      },\n      select: { level: true },\n    });\n    if (duplicate) {\n      return res.status(409).json({ error: 'CODE_ALREADY_IN_USE' });\n    }\n    const record = await prisma.accessCode.upsert({\n      where: { level },\n      update: { codeHash },\n      create: { level, codeHash },\n    });\n    log.info(\"Code d'accès mis à jour\", { level });\n    res.json({ code: formatAccessCode(record) });\n  });\n\n  app.post('/api/access/verify'`;

if (putRouteRegex.test(source)) {
  source = source.replace(putRouteRegex, putRouteReplacement);
  changed = true;
} else {
  console.warn('Skipped missing route: PUT /api/access/codes/:level');
}

const verifyRawRegex = /    const rows = await prisma\.\$queryRaw<Array<\{ level: number \}>>`\n      SELECT level FROM "AccessCode" WHERE code = \$\{input\} LIMIT 1\n    `;\n    if \(rows\.length === 0\) \{\n      log\.debug\(\"Code d'accès refusé\", \{ reason: 'unknown-code' \}\);\n      return res\.json\(\{ level: null, allowed: false, label: 'Code invalide — niveau courant conservé\.' \}\);\n    \}\n    const level = Number\(rows\[0\]\.level\);/;
const verifyRawReplacement = `    const record = await prisma.accessCode.findFirst({\n      where: { codeHash: hashAccessCode(input) },\n      select: { level: true },\n    });\n    if (!record) {\n      log.debug(\"Code d'accès refusé\", { reason: 'unknown-code' });\n      return res.json({ level: null, allowed: false, label: 'Code invalide — niveau courant conservé.' });\n    }\n    const level = Number(record.level);`;

if (verifyRawRegex.test(source)) {
  source = source.replace(verifyRawRegex, verifyRawReplacement);
  changed = true;
} else {
  console.warn('Skipped missing verify raw code lookup');
}

if (!changed) {
  console.log('No changes applied.');
  process.exit(0);
}

writeFileSync(appPath, source, 'utf8');
console.log('Access code routes patched to use codeHash.');
