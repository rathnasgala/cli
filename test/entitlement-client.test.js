import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAttributionEntitlement } from '../src/entitlement-client.js';

const SITE = '01K00000000000000000000010';
const artifact = Object.freeze({
  siteId: SITE, tier: 'PAID', issuedAt: '2026-08-14T00:00:00Z',
  expiresAt: '2026-09-14T00:00:00Z', keyId: 'attribution-v1', signature: 'signature'
});

test('retrieves the exact paid artifact with the author bearer token', async () => {
  const calls = [];
  const result = await fetchAttributionEntitlement({
    siteId: SITE,
    credential: { apiBaseUrl: 'https://api.gala67.com', accessToken: 'jwt' },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, json: async () => artifact };
    }
  });
  assert.deepEqual(result, artifact);
  assert.equal(calls[0].url, `https://api.gala67.com/v1/sites/${SITE}/attribution-entitlement`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer jwt');
});

test('rejects a free or structurally unexpected artifact', async () => {
  await assert.rejects(fetchAttributionEntitlement({
    siteId: SITE,
    credential: { apiBaseUrl: 'https://api.gala67.com', accessToken: 'jwt' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ...artifact, tier: 'FREE' }) })
  }), /response is invalid/);
});
