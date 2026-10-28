/**
 * Idle sign-out (15 minutes for admin and office, a minute's warning) and the
 * new-version check (28 Oct 2026).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idleAppliesTo, idleState, IDLE_LIMIT_MS } from '../src/lib/idle.ts';
import { bundleIn, staleKind } from '../src/lib/version.ts';

const MIN = 60_000;

test('only admin and office logins time out', () => {
  assert.equal(idleAppliesTo('admin'), true);
  assert.equal(idleAppliesTo('user'), true);
  assert.equal(idleAppliesTo('driver'), false);
  assert.equal(idleAppliesTo('customer'), false);
});

test('15 minutes idle signs out, with a warning in the last minute', () => {
  assert.equal(IDLE_LIMIT_MS, 15 * MIN);
  const t0 = 1_000_000;
  assert.deepEqual(idleState(t0, t0 + 13 * MIN), { kind: 'active' });
  assert.deepEqual(idleState(t0, t0 + 14 * MIN), { kind: 'warning', secondsLeft: 60 });
  assert.deepEqual(idleState(t0, t0 + 14 * MIN + 59_500), { kind: 'warning', secondsLeft: 1 });
  assert.deepEqual(idleState(t0, t0 + 15 * MIN), { kind: 'expired' });
  assert.deepEqual(idleState(t0, t0 + 10 * 60 * MIN), { kind: 'expired' }, 'a screen left overnight');
});

const html = (b: string) => `<!doctype html><script type="module" crossorigin src="/assets/${b}"></script>`;
function fakeFetch(answers: Record<string, { status?: number; body: string }>) {
  return async (url: string) => {
    const a = answers[url];
    if (!a) throw new Error('offline');
    return new Response(a.body, { status: a.status ?? 200 });
  };
}

test('reads the bundle from the index page', () => {
  assert.equal(bundleIn(html('index-t1kr5hO0.js')), 'index-t1kr5hO0.js');
  assert.equal(bundleIn('<p>nothing</p>'), null);
});

test('a tab opened before an update is told to reload', async () => {
  const f = fakeFetch({
    '/api/version': { body: JSON.stringify({ build: 'index-NEW.js' }) },
    '/': { body: html('index-NEW.js') },
  });
  assert.equal(await staleKind(f, 'index-OLD.js'), 'page');
  assert.equal(await staleKind(f, 'index-NEW.js'), null, 'up to date');
});

test('a server older than the screens on disk needs a restart', async () => {
  const f = fakeFetch({
    '/api/version': { body: JSON.stringify({ build: 'index-OLD.js' }) },
    '/': { body: html('index-NEW.js') },
  });
  assert.equal(await staleKind(f, 'index-NEW.js'), 'server');
  assert.equal(await staleKind(fakeFetch({ '/api/version': { status: 404, body: '{}' } }), 'index-NEW.js'), 'server');
});

test('offline or dev server: says nothing', async () => {
  assert.equal(await staleKind(fakeFetch({}), 'index-OLD.js'), null);
  assert.equal(await staleKind(fakeFetch({ '/api/version': { body: '{"build":null}' } }), 'index-OLD.js'), null);
  assert.equal(await staleKind(fakeFetch({}), null), null);
});
