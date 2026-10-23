/**
 * The website's pages must never share an address with the app's own
 * screens: signed-in staff opening Delivery rounds (/delivery) were landing
 * on the website's delivery page instead (23 Oct 2026).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('no website page uses an address the app uses', () => {
  const site = readFileSync(join(src, 'site', 'Site.tsx'), 'utf8');
  const app = readFileSync(join(src, 'App.tsx'), 'utf8');
  const list = site.match(/SITE_PATHS = \[([^\]]*)\]/);
  assert.ok(list, 'SITE_PATHS found');
  const sitePaths = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((p) => p !== '/');
  const appPaths = new Set([...app.matchAll(/path="(\/[^"/:]*)/g)].map((m) => m[1]));
  const clash = sitePaths.filter((p) => appPaths.has(p));
  assert.deepEqual(clash, []);
});
