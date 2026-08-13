import assert from 'node:assert/strict';
import test from 'node:test';

import { registerSite } from '../src/site-registration-client.js';

const SITE = '01K00000000000000000000010';

function response(status, payload, location = null) {
  return {
    status,
    headers: { get: (name) => name.toLowerCase() === 'location' ? location : null },
    json: async () => payload
  };
}

test('registers exact repository with both auth and idempotency credentials', async () => {
  let request;
  const result = await registerSite({
    galaAccessToken: 'gala-jwt',
    idempotencyKey: 'scaffold:0123456789abcdef',
    githubInstallationId: 153144989,
    repositoryOwner: 'rathnasgala',
    repositoryName: 'smoke01',
    topology: 'PROVIDER_DEFAULT',
    canonicalBaseUrl: 'https://rathnasgala.github.io',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(201, {
        siteId: SITE,
        siteSecret: 'one-time-secret',
        canonicalBaseUrl: 'https://rathnasgala.github.io',
        pathPrefix: '/smoke01'
      }, `/v1/sites/${SITE}`);
    }
  });

  assert.equal(request.url, 'https://api.gala67.com/v1/sites');
  assert.equal(request.options.headers.authorization, 'Bearer gala-jwt');
  assert.equal(request.options.headers['idempotency-key'], 'scaffold:0123456789abcdef');
  assert.deepEqual(JSON.parse(request.options.body), {
    githubInstallationId: 153144989,
    repositoryOwner: 'rathnasgala',
    repositoryName: 'smoke01',
    topology: 'PROVIDER_DEFAULT',
    canonicalBaseUrl: 'https://rathnasgala.github.io'
  });
  assert.equal(result.siteId, SITE);
  assert.equal(result.siteSecret, 'one-time-secret');
  assert.equal(result.canonicalBaseUrl, 'https://rathnasgala.github.io');
  assert.equal(result.pathPrefix, '/smoke01');
});

test('distinguishes expired Gala auth from missing GitHub App repository access', async () => {
  const base = {
    galaAccessToken: 'token', idempotencyKey: 'scaffold:0123456789abcdef',
    githubInstallationId: 153144989, repositoryOwner: 'rathnasgala', repositoryName: 'smoke01',
    topology: 'PROVIDER_DEFAULT', canonicalBaseUrl: 'https://rathnasgala.github.io'
  };
  await assert.rejects(registerSite({ ...base, fetchImpl: async () => response(401, {}) }), /gala auth/);
  await assert.rejects(registerSite({ ...base, fetchImpl: async () => response(404, {}) }), /does not cover/);
});
