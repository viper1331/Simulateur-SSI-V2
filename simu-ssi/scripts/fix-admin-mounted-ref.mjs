#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const filePath = resolve(process.cwd(), 'apps/admin-studio/src/pages/AdminStudioApp.tsx');
let source = readFileSync(filePath, 'utf8');

const before = `  useEffect(() => {
    return () => {
      isMountedRef.current = false;`;
const after = `  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;`;

if (source.includes(after)) {
  console.log('Mounted ref already patched.');
} else if (source.includes(before)) {
  source = source.replace(before, after);
  writeFileSync(filePath, source, 'utf8');
  console.log('Mounted ref patched.');
} else {
  throw new Error('Mounted ref anchor not found.');
}
