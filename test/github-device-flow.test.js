import assert from 'node:assert/strict';
import test from 'node:test';

import { pollForAccessToken, requestDeviceCode } from '../src/github-device-flow.js';

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

test('requests a device code using form encoding and explicit JSON response negotiation', async () => {
  let request;
  const result = await requestDeviceCode({
    clientId: 'client-id',
    scopes: ['public_repo', 'read:user'],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        device_code: 'device-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5
      });
    }
  });

  assert.equal(request.url, 'https://github.com/login/device/code');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.accept, 'application/json');
  assert.equal(request.options.body.get('scope'), 'public_repo read:user');
  assert.equal(result.userCode, 'ABCD-EFGH');
  assert.equal(result.intervalSeconds, 5);
});

test('honors authorization_pending and slow_down before returning a token', async () => {
  const payloads = [
    { error: 'authorization_pending' },
    { error: 'slow_down' },
    { access_token: 'secret-token', token_type: 'bearer', scope: 'public_repo,read:user' }
  ];
  const waits = [];
  let elapsed = 0;
  const token = await pollForAccessToken({
    clientId: 'client-id',
    deviceCode: 'device-code',
    expiresInSeconds: 900,
    intervalSeconds: 5,
    requiredScopes: ['public_repo'],
    fetchImpl: async () => jsonResponse(payloads.shift()),
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      elapsed += milliseconds;
    },
    now: () => elapsed
  });

  assert.deepEqual(waits, [5000, 5000, 10000]);
  assert.deepEqual(token, {
    accessToken: 'secret-token',
    tokenType: 'bearer',
    scopes: ['public_repo', 'read:user']
  });
});

test('normalizes comma and RFC whitespace-delimited OAuth scopes', async () => {
  const token = await pollForAccessToken({
    clientId: 'client-id',
    deviceCode: 'device-code',
    expiresInSeconds: 900,
    intervalSeconds: 5,
    requiredScopes: [' REPO ', 'Read:User'],
    fetchImpl: async () => jsonResponse({
      access_token: 'secret-token',
      token_type: 'bearer',
      scope: 'repo\tREAD:USER,workflow\n'
    }),
    sleep: async () => {},
    now: () => 0
  });

  assert.deepEqual(token.scopes, ['repo', 'read:user', 'workflow']);
});

test('rejects terminal errors, local expiry, malformed responses, and HTTP failures', async () => {
  const base = {
    clientId: 'client-id',
    deviceCode: 'device-code',
    expiresInSeconds: 10,
    intervalSeconds: 5,
    sleep: async () => {},
    now: (() => {
      let value = 0;
      return () => value += 5000;
    })()
  };
  await assert.rejects(
    () => pollForAccessToken({ ...base, fetchImpl: async () => jsonResponse({ error: 'access_denied' }) }),
    /access_denied/
  );
  await assert.rejects(
    () => pollForAccessToken({ ...base, fetchImpl: async () => jsonResponse({ error: 'authorization_pending' }) }),
    /expired/
  );
  await assert.rejects(
    () => requestDeviceCode({
      clientId: 'client-id',
      scopes: ['public_repo'],
      fetchImpl: async () => jsonResponse([], {})
    }),
    /JSON object/
  );
  await assert.rejects(
    () => requestDeviceCode({
      clientId: 'client-id',
      scopes: ['public_repo'],
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 503 })
    }),
    /HTTP 503/
  );
});

test('rejects non-bearer tokens and tokens missing a required scope', async () => {
  const options = {
    clientId: 'client-id',
    deviceCode: 'device-code',
    expiresInSeconds: 900,
    intervalSeconds: 5,
    requiredScopes: ['repo'],
    sleep: async () => {},
    now: () => 0
  };
  await assert.rejects(
    () => pollForAccessToken({
      ...options,
      fetchImpl: async () => jsonResponse({
        access_token: 'token',
        token_type: 'mac',
        scope: 'repo'
      })
    }),
    /must be bearer/
  );
  await assert.rejects(
    () => pollForAccessToken({
      ...options,
      fetchImpl: async () => jsonResponse({
        access_token: 'token',
        token_type: 'bearer',
        scope: 'public_repo'
      })
    }),
    /omitted required scope.*repo/
  );
});
