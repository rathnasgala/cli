import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTopologyChange, commitTopologyChange } from '../src/topology-client.js';

const SITE = '01K00000000000000000000010';
const CHANGE = '01K00000000000000000000020';

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('prepares and commits the exact owner topology contract', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return response({ changeId: CHANGE, state: calls.length === 1 ? 'PREPARED' : 'COMMITTED' });
  };

  await prepareTopologyChange({
    apiBaseUrl: 'https://api.gala67.com', accessToken: 'jwt', siteId: SITE,
    canonicalBaseUrl: 'https://blog.example.com', pathPrefix: '/notes', fetchImpl
  });
  await commitTopologyChange({
    apiBaseUrl: 'https://api.gala67.com', accessToken: 'jwt', siteId: SITE,
    changeId: CHANGE, fetchImpl
  });

  assert.equal(calls[0][0], `https://api.gala67.com/v1/sites/${SITE}/topology-changes/prepare`);
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    canonicalBaseUrl: 'https://blog.example.com', pathPrefix: '/notes'
  });
  assert.equal(calls[1][0], `https://api.gala67.com/v1/sites/${SITE}/topology-changes/${CHANGE}/commit`);
  assert.equal(calls[1][1].method, 'POST');
});

test('does not turn an unverified topology conflict into success', async () => {
  await assert.rejects(prepareTopologyChange({
    apiBaseUrl: 'https://api.gala67.com', accessToken: 'jwt', siteId: SITE,
    canonicalBaseUrl: 'https://blog.example.com', pathPrefix: '/',
    fetchImpl: async () => response({}, 409)
  }), /conflicts with protected state/);
});
