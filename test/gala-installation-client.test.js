import assert from 'node:assert/strict';
import test from 'node:test';

import {
  exchangeGithubAuthorization,
  listAuthorizedRepositories,
  resolveInstallationId
} from '../src/gala-installation-client.js';

test('exchanges the GitHub token for the bounded capability the repository list requires', async () => {
  const seen = [];
  const authorization = await exchangeGithubAuthorization({
    apiBaseUrl: 'https://api.gala67.com/',
    galaAccessToken: 'gala-token',
    githubAccessToken: 'github-token',
    fetchImpl: async (url, init) => {
      seen.push([url, init]);
      return { ok: true, status: 200, json: async () => ({ authorization: 'a'.repeat(43) }) };
    }
  });

  assert.equal(authorization, 'a'.repeat(43));
  // The trailing slash on the base URL must not produce a doubled path separator.
  assert.equal(seen[0][0], 'https://api.gala67.com/v1/auth/github/device-authorizations');
  assert.equal(seen[0][1].method, 'POST');
  assert.equal(seen[0][1].headers.authorization, 'Bearer gala-token');
  assert.deepEqual(JSON.parse(seen[0][1].body), { accessToken: 'github-token' });
});

test('sends the capability as the GitHub-Authorization header, not as a bearer token', async () => {
  const seen = [];
  await listAuthorizedRepositories({
    apiBaseUrl: 'https://api.gala67.com',
    authorization: 'b'.repeat(43),
    fetchImpl: async (url, init) => {
      seen.push([url, init]);
      return { ok: true, status: 200, json: async () => [] };
    }
  });

  assert.equal(seen[0][0], 'https://api.gala67.com/v1/auth/github/repositories');
  assert.equal(seen[0][1].headers['GitHub-Authorization'], 'b'.repeat(43));
  assert.equal(seen[0][1].headers.authorization, undefined);
});

test('finds the installation covering the owner regardless of which repository carries it', async () => {
  const installationId = await resolveInstallationId({
    apiBaseUrl: 'https://api.gala67.com',
    galaAccessToken: 'gala-token',
    githubAccessToken: 'github-token',
    owner: 'RathnasGala',
    exchange: async () => 'c'.repeat(43),
    list: async () => [
      { installationId: 111, owner: 'someone-else', name: 'other', status: 'READY' },
      { installationId: 153144989, owner: 'rathnasgala', name: 'smoke01', status: 'ALREADY_CONNECTED' }
    ]
  });

  // Owner comparison is case-insensitive: GitHub preserves the case a login was created with, and
  // the writer may type it either way.
  assert.equal(installationId, 153144989);
});

test('answers null when the App is not installed on the owner, rather than throwing', async () => {
  const installationId = await resolveInstallationId({
    apiBaseUrl: 'https://api.gala67.com',
    galaAccessToken: 'gala-token',
    githubAccessToken: 'github-token',
    owner: 'rathnasgala',
    exchange: async () => 'd'.repeat(43),
    list: async () => [{ installationId: 111, owner: 'someone-else', name: 'other', status: 'READY' }]
  });

  assert.equal(installationId, null);
});

test('ignores entries whose installationId is not a usable positive integer', async () => {
  const installationId = await resolveInstallationId({
    apiBaseUrl: 'https://api.gala67.com',
    galaAccessToken: 'gala-token',
    githubAccessToken: 'github-token',
    owner: 'rathnasgala',
    exchange: async () => 'e'.repeat(43),
    list: async () => [
      { installationId: 0, owner: 'rathnasgala', name: 'a' },
      { installationId: -3, owner: 'rathnasgala', name: 'b' },
      { installationId: 'nope', owner: 'rathnasgala', name: 'c' },
      { installationId: 153144989, owner: 'rathnasgala', name: 'd' }
    ]
  });

  assert.equal(installationId, 153144989);
});

test('reports the status when the API refuses either call', async () => {
  await assert.rejects(
    exchangeGithubAuthorization({
      apiBaseUrl: 'https://api.gala67.com', galaAccessToken: 'g', githubAccessToken: 'h',
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
    }),
    /HTTP 401/
  );
  await assert.rejects(
    listAuthorizedRepositories({
      apiBaseUrl: 'https://api.gala67.com', authorization: 'f'.repeat(43),
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
    }),
    /HTTP 503/
  );
});
