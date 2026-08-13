import assert from 'node:assert/strict';
import test from 'node:test';

import { pollForGalaToken, requestGalaDeviceCode } from '../src/gala-device-flow.js';

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('requests separate RFC device and user codes with the public client ID', async () => {
  let request;
  const result = await requestGalaDeviceCode({
    apiBaseUrl: 'https://api.gala67.com',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, {
        device_code: 'opaque-secret-device-code',
        user_code: '2345-6789',
        verification_uri: 'https://api.gala67.com/v1/auth/device',
        verification_uri_complete: 'https://api.gala67.com/v1/auth/device?user_code=2345-6789',
        expires_in: 600,
        interval: 5
      });
    }
  });

  assert.equal(request.url, 'https://api.gala67.com/v1/auth/device/code');
  assert.equal(request.options.body.get('client_id'), 'gala-cli');
  assert.equal(result.deviceCode, 'opaque-secret-device-code');
  assert.equal(result.userCode, '2345-6789');
  assert.notEqual(result.deviceCode, result.userCode);
});

test('polls by device code, backs off five seconds on slow_down, and returns bearer token', async () => {
  const sleeps = [];
  const requests = [];
  const replies = [
    response(400, { error: 'authorization_pending' }),
    response(400, { error: 'slow_down' }),
    response(200, { access_token: 'gala-jwt', token_type: 'bearer', expires_in: 2_592_000 })
  ];
  let clock = 1_000;
  const result = await pollForGalaToken({
    deviceCode: 'opaque-device-code',
    expiresInSeconds: 600,
    intervalSeconds: 5,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return replies.shift();
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    now: () => clock
  });

  assert.deepEqual(sleeps, [5_000, 5_000, 10_000]);
  assert.equal(result.accessToken, 'gala-jwt');
  assert.ok(requests.every(({ options }) =>
    options.body.get('device_code') === 'opaque-device-code'
    && options.body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code'
  ));
});

test('reports expiry and denial with explicit Gala reauthentication guidance', async () => {
  await assert.rejects(
    pollForGalaToken({
      deviceCode: 'opaque', expiresInSeconds: 1, intervalSeconds: 1,
      sleep: async () => {}, now: (() => { let value = 0; return () => (value += 1_000); })(),
      fetchImpl: async () => { throw new Error('must expire before polling'); }
    }),
    /run `gala auth` again/
  );
  await assert.rejects(
    pollForGalaToken({
      deviceCode: 'opaque', expiresInSeconds: 10, intervalSeconds: 1,
      sleep: async () => {}, now: () => 0,
      fetchImpl: async () => response(400, { error: 'access_denied' })
    }),
    /was denied/
  );
});

test('reports an upstream non-JSON response without echoing its body', async () => {
  const sensitiveBody = '<html>proxy failure containing credential material</html>';
  await assert.rejects(
    requestGalaDeviceCode({
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        json: async () => { throw new SyntaxError(sensitiveBody); }
      })
    }),
    (error) => {
      assert.match(error.message, /invalid JSON \(HTTP 502\)/);
      assert.doesNotMatch(error.message, /credential material/);
      return true;
    }
  );
});
