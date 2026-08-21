import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveGithubLogin } from '../src/github-identity.js';

test('reads the account login from the stored credential instead of asking for --owner', async () => {
  const seen = [];
  const login = await resolveGithubLogin({
    accessToken: 'github-token',
    fetchImpl: async (url, init) => {
      seen.push([url, init]);
      return { ok: true, status: 200, json: async () => ({ login: 'rathnasgala', id: 42 }) };
    }
  });

  assert.equal(login, 'rathnasgala');
  assert.equal(seen[0][0], 'https://api.github.com/user');
  assert.equal(seen[0][1].headers.authorization, 'Bearer github-token');
  assert.equal(seen[0][1].headers['x-github-api-version'], '2026-03-10');
});

test('refuses a login GitHub would not accept as a repository owner', async () => {
  for (const login of ['', 'has space', '-leading', 'trailing-', 42, null]) {
    await assert.rejects(
      resolveGithubLogin({
        accessToken: 'github-token',
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ login }) })
      }),
      /unusable account login/
    );
  }
});

test('surfaces the HTTP status when the lookup fails', async () => {
  await assert.rejects(
    resolveGithubLogin({
      accessToken: 'github-token',
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
    }),
    /HTTP 401/
  );
});

test('requires an access token', async () => {
  await assert.rejects(resolveGithubLogin({ accessToken: '' }), /accessToken is required/);
});
