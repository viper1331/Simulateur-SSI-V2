#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

function read(relativePath) {
  const path = resolve(root, relativePath);
  if (!existsSync(path)) {
    throw new Error(`Missing file: ${relativePath}`);
  }
  return { path, content: readFileSync(path, 'utf8') };
}

function writeIfChanged(path, before, after) {
  if (after === before) {
    console.log(`No change: ${path}`);
    return false;
  }
  writeFileSync(path, after, 'utf8');
  console.log(`Updated: ${path}`);
  return true;
}

function replaceBlock(source, startAnchor, endAnchors, replacement) {
  const start = source.indexOf(startAnchor);
  if (start === -1) {
    throw new Error(`Unable to find start anchor: ${startAnchor}`);
  }
  const candidates = endAnchors
    .map((anchor) => ({ anchor, index: source.indexOf(anchor, start + startAnchor.length) }))
    .filter((candidate) => candidate.index !== -1)
    .sort((a, b) => a.index - b.index);
  if (candidates.length === 0) {
    throw new Error(`Unable to find end anchor after: ${startAnchor}`);
  }
  const end = candidates[0].index;
  return `${source.slice(0, start)}${replacement}\n\n${source.slice(end)}`;
}

function patchServerApp(source) {
  let out = source;

  if (!out.includes("from './access-codes'")) {
    out = out.replace(
      "import { recordManualCallPointActivation, recordManualCallPointReset } from './manual-call-points';",
      "import { recordManualCallPointActivation, recordManualCallPointReset } from './manual-call-points';\nimport { formatAccessCodeMetadata, hashAccessCode, verifyAccessCodeHash } from './access-codes';",
    );
  }

  if (!out.includes('SELECT level, codeHash, updatedAt FROM "AccessCode" ORDER BY level ASC')) {
    out = replaceBlock(
      out,
      "  app.get('/api/access/codes'",
      ["  app.put('/api/access/codes/:level'"],
      `  app.get('/api/access/codes', async (_req, res) => {\n    const rows = await prisma.$queryRaw<Array<{ level: number; codeHash: string | null; updatedAt: string }>>\`\n      SELECT level, codeHash, updatedAt FROM "AccessCode" ORDER BY level ASC\n    \`;\n    const codes = rows.map((row) =>\n      formatAccessCodeMetadata(Number(row.level), row.codeHash, row.updatedAt),\n    );\n    log.debug("Métadonnées des codes d'accès renvoyées", { count: codes.length });\n    res.json({ codes });\n  });`,
    );
  }

  if (!out.includes('hashAccessCode(code);')) {
    out = replaceBlock(
      out,
      "  app.put('/api/access/codes/:level'",
      ["  app.post('/api/access/verify'"],
      `  app.put('/api/access/codes/:level', async (req, res) => {\n    const level = Number(req.params.level);\n    if (!Number.isFinite(level) || level < 1 || level > 3) {\n      return res.status(400).json({ error: 'INVALID_LEVEL' });\n    }\n    const parsed = accessCodeUpdateSchema.safeParse(req.body);\n    if (!parsed.success) {\n      return res.status(400).json({ error: parsed.error.message });\n    }\n    const code = parsed.data.code.trim();\n    const existingRows = await prisma.$queryRaw<Array<{ level: number; codeHash: string | null }>>\`\n      SELECT level, codeHash FROM "AccessCode" WHERE level != ${'${level}'}\n    \`;\n    const duplicate = existingRows.some((row) => verifyAccessCodeHash(code, row.codeHash));\n    if (duplicate) {\n      return res.status(409).json({ error: 'CODE_ALREADY_IN_USE' });\n    }\n    const codeHash = hashAccessCode(code);\n    await prisma.$executeRaw\`\n      INSERT INTO "AccessCode" ("level", "codeHash", "updatedAt") VALUES (${'${level}'}, ${'${codeHash}'}, CURRENT_TIMESTAMP)\n      ON CONFLICT("level") DO UPDATE SET "codeHash" = excluded."codeHash", "updatedAt" = CURRENT_TIMESTAMP\n    \`;\n    const [record] = await prisma.$queryRaw<Array<{ level: number; codeHash: string | null; updatedAt: string }>>\`\n      SELECT level, codeHash, updatedAt FROM "AccessCode" WHERE level = ${'${level}'}\n    \`;\n    if (!record) {\n      return res.status(500).json({ error: 'ACCESS_CODE_NOT_FOUND' });\n    }\n    log.info("Code d'accès mis à jour", { level });\n    res.json({ code: formatAccessCodeMetadata(Number(record.level), record.codeHash, record.updatedAt) });\n  });`,
    );
  }

  if (!out.includes('verifyAccessCodeHash(input, row.codeHash)')) {
    out = replaceBlock(
      out,
      "  app.post('/api/access/verify'",
      [
        "  app.post('/api/evac/manual/start'",
        "  app.post('/api/evac/manual/stop'",
        "  app.post('/api/process/ack'",
        "  app.post('/api/uga/silence'",
        "  app.post('/api/sdi/dm'",
      ],
      `  app.post('/api/access/verify', async (req, res) => {\n    const parsed = accessCodeVerifySchema.safeParse(req.body ?? {});\n    if (!parsed.success) {\n      return res.status(400).json({ error: parsed.error.message });\n    }\n    const input = parsed.data.code.trim();\n    if (input.length === 0) {\n      log.debug("Vérification du code d'accès accordée par défaut");\n      return res.json({ level: 1, allowed: true, label: 'Accès niveau 1 actif — arrêt signal sonore disponible.' });\n    }\n    const rows = await prisma.$queryRaw<Array<{ level: number; codeHash: string | null }>>\`\n      SELECT level, codeHash FROM "AccessCode" WHERE codeHash IS NOT NULL\n    \`;\n    const match = rows.find((row) => verifyAccessCodeHash(input, row.codeHash));\n    if (!match) {\n      log.debug("Code d'accès refusé", { reason: 'unknown-code-or-not-configured' });\n      return res.json({ level: null, allowed: false, label: 'Code invalide — niveau courant conservé.' });\n    }\n    const level = Number(match.level);\n    if (level >= 3) {\n      log.debug("Code d'accès niveau 3 accepté");\n      return res.json({ level, allowed: true, label: 'Accès niveau 3 actif — commandes avancées disponibles.' });\n    }\n    if (level === 2) {\n      log.debug("Code d'accès niveau 2 accepté");\n      return res.json({ level, allowed: true, label: 'Accès niveau 2 actif — commandes de conduite disponibles.' });\n    }\n    log.debug("Code d'accès niveau 1 accepté");\n    return res.json({ level, allowed: true, label: 'Accès niveau 1 actif — arrêt signal sonore disponible.' });\n  });`,
    );
  }

  return out;
}

function patchSdk(source) {
  let out = source;

  out = out.replace(
    "const accessCodeSchema = z.object({\n  level: z.number().int().min(1).max(3),\n  code: z.string().min(1),\n  updatedAt: z.string(),\n});",
    "const accessCodeSchema = z.object({\n  level: z.number().int().min(1).max(3),\n  code: z.string().min(1),\n  configured: z.boolean().default(false),\n  updatedAt: z.string(),\n});",
  );

  return out;
}

let changed = false;
{
  const { path, content } = read('apps/server/src/app.ts');
  changed = writeIfChanged(path, content, patchServerApp(content)) || changed;
}
{
  const { path, content } = read('packages/sdk/src/index.ts');
  changed = writeIfChanged(path, content, patchSdk(content)) || changed;
}

if (!changed) {
  console.log('Hashed access code integration is already applied.');
}
