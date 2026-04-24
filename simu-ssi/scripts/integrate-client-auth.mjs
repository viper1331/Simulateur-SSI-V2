#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

function patchFile(relativePath, patcher) {
  const path = resolve(root, relativePath);
  if (!existsSync(path)) {
    console.warn(`Skipped missing file: ${relativePath}`);
    return false;
  }
  const before = readFileSync(path, 'utf8');
  const after = patcher(before, relativePath);
  if (after === before) {
    console.log(`No change: ${relativePath}`);
    return false;
  }
  writeFileSync(path, after, 'utf8');
  console.log(`Updated: ${relativePath}`);
  return true;
}

function mustReplace(source, searchValue, replaceValue, label) {
  if (!source.includes(searchValue)) {
    return source;
  }
  return source.replace(searchValue, replaceValue);
}

function patchSdk(source) {
  let out = source;

  if (!out.includes('export interface SsiSdkOptions')) {
    const anchor = `export interface SessionCloseRequest {\n  notes?: string | null;\n  improvementAreas?: SessionImprovement[];\n  endedAt?: string;\n}\n\nexport class SsiSdk {`;
    if (!out.includes(anchor)) {
      throw new Error('Unable to insert SsiSdkOptions: SessionCloseRequest anchor not found.');
    }
    out = out.replace(
      anchor,
      `export interface SessionCloseRequest {\n  notes?: string | null;\n  improvementAreas?: SessionImprovement[];\n  endedAt?: string;\n}\n\nexport interface SsiSdkOptions {\n  apiToken?: string;\n}\n\nexport class SsiSdk {`,
    );
  }

  out = mustReplace(
    out,
    'export class SsiSdk {\n  constructor(private readonly baseUrl: string) {}',
    `export class SsiSdk {\n  private readonly apiToken?: string;\n\n  constructor(private readonly baseUrl: string, options: SsiSdkOptions = {}) {\n    this.apiToken = options.apiToken?.trim() || undefined;\n  }`,
    'SsiSdk constructor',
  );

  if (!out.includes('private readonly apiToken?: string;')) {
    throw new Error('Unable to patch SsiSdk constructor with apiToken support.');
  }

  // Replace direct fetch calls inside the SDK class. This keeps public method behavior unchanged
  // while centralizing Authorization header injection in request().
  out = out.replace(/await fetch\(/g, 'await this.request(');

  if (!out.includes('private async request(')) {
    const postAnchor = '  private async post(path: string, body?: unknown) {';
    const anchorIndex = out.indexOf(postAnchor);
    if (anchorIndex === -1) {
      throw new Error('Unable to insert SDK request helper: private post() anchor not found.');
    }
    const requestHelper = `  private async request(pathOrUrl: string | URL, init: RequestInit = {}): Promise<Response> {\n    const url = pathOrUrl instanceof URL ? pathOrUrl.toString() : pathOrUrl.startsWith('http') ? pathOrUrl : \`${'${this.baseUrl}'}${'${pathOrUrl}'}\`;\n    const headers = new Headers(init.headers);\n    if (this.apiToken && !headers.has('Authorization')) {\n      headers.set('Authorization', \`Bearer ${'${this.apiToken}'}\`);\n    }\n    return fetch(url, { ...init, headers });\n  }\n\n`;
    out = `${out.slice(0, anchorIndex)}${requestHelper}${out.slice(anchorIndex)}`;
  }

  // Make post() rely on the same centralized header logic without double-prefixing baseUrl.
  out = out.replace(
    /const response = await this\.request\(`\$\{this\.baseUrl\}\$\{path\}`, \{[\s\S]*?body: body \? JSON\.stringify\(body\) : undefined,\n    \}\);/,
    `const headers = new Headers();\n    if (body !== undefined) {\n      headers.set('Content-Type', 'application/json');\n    }\n    const response = await this.request(path, {\n      method: 'POST',\n      headers,\n      body: body ? JSON.stringify(body) : undefined,\n    });`,
  );

  if (!out.includes('Authorization')) {
    throw new Error('SDK request helper was not inserted correctly.');
  }

  return out;
}

function patchViteClient(source) {
  let out = source;

  const helper = `\nfunction getConfiguredApiToken(): string | undefined {\n  const token = import.meta.env.VITE_SIMU_SSI_API_TOKEN;\n  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : undefined;\n}\n\nfunction createSocketOptions() {\n  const token = getConfiguredApiToken();\n  return token ? { auth: { token } } : undefined;\n}\n`;

  if (!out.includes('function getConfiguredApiToken()')) {
    const firstConstIndex = out.indexOf('const ');
    if (firstConstIndex === -1) {
      throw new Error('Unable to find insertion anchor for client auth helpers.');
    }
    out = `${out.slice(0, firstConstIndex)}${helper}\n${out.slice(firstConstIndex)}`;
  }

  out = out.replace(/new SsiSdk\(([^\n)]*)\)/g, (match, args) => {
    if (match.includes('getConfiguredApiToken')) {
      return match;
    }
    return `new SsiSdk(${args}, { apiToken: getConfiguredApiToken() })`;
  });

  out = out.replace(/io\(([^\n)]*)\)/g, (match, args) => {
    if (match.includes('createSocketOptions')) {
      return match;
    }
    return `io(${args}, createSocketOptions())`;
  });

  return out;
}

const changed = [
  patchFile('packages/sdk/src/index.ts', patchSdk),
  patchFile('apps/trainer-console/src/pages/App.tsx', patchViteClient),
  patchFile('apps/trainee-station/src/pages/App.tsx', patchViteClient),
  patchFile('apps/admin-studio/src/pages/App.tsx', patchViteClient),
].some(Boolean);

if (!changed) {
  console.log('Client token propagation is already integrated.');
}
