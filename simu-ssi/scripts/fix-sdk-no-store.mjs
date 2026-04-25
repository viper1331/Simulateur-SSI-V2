#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sdkPath = resolve(process.cwd(), 'packages/sdk/src/index.ts');
let source = readFileSync(sdkPath, 'utf8');

const before = `  private async request(pathOrUrl: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = pathOrUrl instanceof URL ? pathOrUrl.toString() : pathOrUrl.startsWith('http') ? pathOrUrl : \`${'${this.baseUrl}'}${'${pathOrUrl}'}\`;
    const headers = new Headers(init.headers);
    if (this.apiToken && !headers.has('Authorization')) {
      headers.set('Authorization', \`Bearer ${'${this.apiToken}'}\`);
    }
    return fetch(url, { ...init, headers });
  }`;

const after = `  private async request(pathOrUrl: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = pathOrUrl instanceof URL ? pathOrUrl.toString() : pathOrUrl.startsWith('http') ? pathOrUrl : \`${'${this.baseUrl}'}${'${pathOrUrl}'}\`;
    const headers = new Headers(init.headers);
    if (this.apiToken && !headers.has('Authorization')) {
      headers.set('Authorization', \`Bearer ${'${this.apiToken}'}\`);
    }
    if (!headers.has('Cache-Control')) {
      headers.set('Cache-Control', 'no-store');
    }
    if (!headers.has('Pragma')) {
      headers.set('Pragma', 'no-cache');
    }
    return fetch(url, { ...init, headers, cache: 'no-store' });
  }`;

if (!source.includes(before)) {
  if (source.includes("cache: 'no-store'")) {
    console.log('SDK request cache bypass is already configured.');
    process.exit(0);
  }
  throw new Error('SDK request helper anchor not found.');
}

source = source.replace(before, after);
writeFileSync(sdkPath, source, 'utf8');
console.log('SDK request cache bypass configured.');
