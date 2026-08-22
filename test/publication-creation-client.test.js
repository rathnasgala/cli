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

test('NEEDS_SHARING says which repository to share and how to continue', async () => {
  /*
   * The API reports this when the repository was created with the right content but the App
   * installation cannot reach it yet. It is the reason CLI-created repositories did not appear in
   * the web UI, and it is recoverable — so it must not read as a generic failure.
   */
  await assert.rejects(
    createPublication({
      ...base,
      fetchImpl: async () => reply({
        status: 'NEEDS_SHARING', owner: 'saranfrog2', name: 'cli67test',
        outcome: 'CREATED_NEEDS_SHARING'
      })
    }),
    (error) => /saranfrog2\/cli67test/.test(error.message)
      && /settings\/installations/.test(error.message)
      && /--resume/.test(error.message)
  );
});

test('MANUAL names the outcome instead of failing anonymously', async () => {
  await assert.rejects(
    createPublication({
      ...base,
      fetchImpl: async () => reply({ status: 'MANUAL', outcome: 'NO_INSTALLATION' })
    }),
    /NO_INSTALLATION.*site-template.*--empty-existing-repository/s
  );
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
