import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublication } from '../src/publication-creation-client.js';

const base = {
  apiBaseUrl: 'https://api.gala67.com',
  galaAccessToken: 'gala-token',
  githubAccessToken: 'gho_token',
  name: 'cli67test',
  authorize: async () => 'c'.repeat(43)
};

function reply(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'content-type': 'application/json' }
  });
}

test('creates through the same endpoint the browser editor uses, with both credentials', async () => {
  const seen = [];
  const created = await createPublication({
    ...base,
    fetchImpl: async (url, init) => {
      seen.push([String(url), init]);
      return reply({
        status: 'READY', installationId: 155579156, owner: 'saranfrog2', name: 'cli67test',
        outcome: 'CREATED_FROM_TEMPLATE'
      });
    }
  });

  assert.equal(seen[0][0], 'https://api.gala67.com/v1/auth/github/publications');
  assert.equal(seen[0][1].headers.authorization, 'Bearer gala-token');
  assert.equal(seen[0][1].headers['GitHub-Authorization'], 'c'.repeat(43));
  assert.deepEqual(JSON.parse(seen[0][1].body), { name: 'cli67test' });
  assert.equal(created.installationId, 155579156);
  assert.equal(created.fullName, 'saranfrog2/cli67test');
  assert.equal(created.cloneUrl, 'https://github.com/saranfrog2/cli67test.git');
});

test('NEEDS_SHARING is recoverable: share the repository, ask again, continue', async () => {
  /*
   * The repository exists with the right content and the App installation simply cannot see it,
   * because it covers selected repositories rather than all of them. That is one click from
   * working, and the browser editor recovers from it — the CLI used to dead-end, telling the writer
   * to use --resume, which needs a local checkout that was never created.
   *
   * After the first attempt the repository exists, so the server reports UNSUPPORTED rather than
   * NEEDS_SHARING: the same situation under a different name.
   */
  const messages = [];
  const opened = [];
  let shared = false;
  let calls = 0;

  const created = await createPublication({
    ...base,
    notify: (message) => messages.push(message),
    openUrl: (url) => { opened.push(url); return true; },
    ask: async () => { shared = true; return ''; },
    fetchImpl: async () => {
      calls += 1;
      if (shared) {
        return reply({
          status: 'READY', installationId: 4568309, owner: 'rathnasgala', name: 'cli67test',
          outcome: 'ALREADY_SHARED'
        });
      }
      return reply(calls === 1
        ? { status: 'NEEDS_SHARING', owner: 'rathnasgala', name: 'cli67test', outcome: 'CREATED_NEEDS_SHARING' }
        : { status: 'MANUAL', outcome: 'UNSUPPORTED' });
    }
  });

  assert.equal(created.fullName, 'rathnasgala/cli67test');
  assert.equal(created.installationId, 4568309);
  assert.ok(messages.some((m) => m.includes('cannot reach it yet')));
  assert.deepEqual(opened, ['https://github.com/settings/installations']);
});

test('a repository that is never shared fails with what to do, not with --resume', async () => {
  await assert.rejects(
    createPublication({
      ...base,
      shareAttempts: 2,
      ask: async () => '',
      fetchImpl: async () => reply({
        status: 'NEEDS_SHARING', owner: 'rathnasgala', name: 'cli67test',
        outcome: 'CREATED_NEEDS_SHARING'
      })
    }),
    (error) => /still cannot reach/.test(error.message)
      && /settings\/installations/.test(error.message)
      && !/--resume/.test(error.message)
  );
});

test('a first-attempt MANUAL is not a sharing problem, and says so without looping', async () => {
  // Nothing was created, so there is nothing to share; prompting would waste the writer's time.
  let calls = 0;
  await assert.rejects(
    createPublication({
      ...base,
      ask: async () => assert.fail('a first-attempt MANUAL must not prompt for sharing'),
      fetchImpl: async () => { calls += 1; return reply({ status: 'MANUAL', outcome: 'NO_INSTALLATION' }); }
    }),
    /NO_INSTALLATION.*site-template.*--empty-existing-repository/s
  );
  assert.equal(calls, 1);
});

test('refuses a READY answer that names no repository or no installation', async () => {
  for (const payload of [
    { status: 'READY', installationId: 1 },
    { status: 'READY', owner: 'saranfrog2', name: 'cli67test' },
    { status: 'READY', owner: 'saranfrog2', name: 'cli67test', installationId: 0 }
  ]) {
    await assert.rejects(
      createPublication({ ...base, fetchImpl: async () => reply(payload) }), TypeError);
  }
});

test('carries the API failure text rather than a bare status', async () => {
  await assert.rejects(
    createPublication({
      ...base,
      fetchImpl: async () => reply({ code: 'GITHUB_APP_NOT_INSTALLED', message: 'not installed' }, 409)
    }),
    /HTTP 409.*not installed/s
  );
});
