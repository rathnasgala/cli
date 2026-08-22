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

test('sends the Gala bearer and the capability, because the endpoint requires both', async () => {
  /*
   * This assertion previously required the bearer to be ABSENT, which is how a request that the
   * security filter rejects before any handler runs shipped with a green suite. The endpoint is
   * `.authenticated()` and its handler takes the Gala principal: the bearer says who is asking,
   * the capability says what they may see, and neither substitutes for the other.
   */
  const seen = [];
  await listAuthorizedRepositories({
    apiBaseUrl: 'https://api.gala67.com',
    authorization: 'b'.repeat(43),
    galaAccessToken: 'gala-token',
    fetchImpl: async (url, init) => {
      seen.push([url, init]);
      return { ok: true, status: 200, json: async () => [] };
    }
  });

  assert.equal(seen[0][0], 'https://api.gala67.com/v1/auth/github/repositories');
  assert.equal(seen[0][1].headers['GitHub-Authorization'], 'b'.repeat(43));
  assert.equal(seen[0][1].headers.authorization, 'Bearer gala-token');
});

test('carries the bearer through the installation lookup, not just the direct call', async () => {
  const seen = [];
  await resolveInstallationId({
    apiBaseUrl: 'https://api.gala67.com',
    galaAccessToken: 'gala-token',
    githubAccessToken: 'github-token',
    owner: 'saranfrog2',
    exchange: async () => 'c'.repeat(43),
    list: async (input) => {
      seen.push(input);
      return [{ installationId: 155579156, owner: 'saranfrog2', name: 'x', status: 'READY' }];
    }
  });
  assert.equal(seen[0].galaAccessToken, 'gala-token');
  assert.equal(seen[0].authorization, 'c'.repeat(43));
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

test('turns a refused authorization into an instruction, not a status code', async () => {
  // 401 here means one of the two credentials is finished, and the caller cannot tell which. A
  // bare "HTTP 401" leaves the writer with nothing to do about it.
  await assert.rejects(
    exchangeGithubAuthorization({
      apiBaseUrl: 'https://api.gala67.com', galaAccessToken: 'g', githubAccessToken: 'h',
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) })
    }),
    /auth github/
  );
  await assert.rejects(
    exchangeGithubAuthorization({
      apiBaseUrl: 'https://api.gala67.com', galaAccessToken: 'g', githubAccessToken: 'h',
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) })
    }),
    /HTTP 500/
  );
  await assert.rejects(
    listAuthorizedRepositories({
      apiBaseUrl: 'https://api.gala67.com', authorization: 'f'.repeat(43),
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
    }),
    /HTTP 503/
  );
});

test('signals a missing App installation instead of throwing, so the caller can offer the fix', async () => {
  // The API answers 409 GITHUB_APP_NOT_INSTALLED when the writer's token is valid but the Gala
  // GitHub App covers no account of theirs. That is a browser step, not a failure.
  const authorization = await exchangeGithubAuthorization({
    apiBaseUrl: 'https://api.gala67.com',
    galaAccessToken: 'gala-token',
    githubAccessToken: 'github-token',
    fetchImpl: async () => ({
      ok: false, status: 409,
      json: async () => ({ code: 'GITHUB_APP_NOT_INSTALLED' })
    })
  });
  assert.equal(authorization, null);

  const installationId = await resolveInstallationId({
    apiBaseUrl: 'https://api.gala67.com',
    galaAccessToken: 'gala-token',
    githubAccessToken: 'github-token',
    owner: 'ada',
    exchange: async () => null,
    list: async () => assert.fail('the repository list must not be requested without a capability')
  });
  assert.equal(installationId, null);
});
