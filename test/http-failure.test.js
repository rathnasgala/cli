import assert from 'node:assert/strict';
import test from 'node:test';

import { describeHttpFailure } from '../src/http-failure.js';

function response(status, body) {
  const make = () => ({ status, text: async () => body, clone: make });
  return make();
}

test('carries the reason GitHub gives, which is the only place it appears', async () => {
  // The exact shape of an organisation OAuth App restriction, which is indistinguishable from a
  // missing scope or a rename if only the status code survives.
  const message = await describeHttpFailure(response(403, JSON.stringify({
    message: 'Although you appear to have the correct authorization credentials, the `rathnasgala` '
      + 'organization has enabled OAuth App access restrictions.',
    documentation_url: 'https://docs.github.com/articles/restricting-access-to-your-organization-s-data/'
  })), 'GitHub template generation');

  assert.match(message, /HTTP 403/);
  assert.match(message, /OAuth App access restrictions/);
  assert.match(message, /See https:\/\/docs\.github\.com/);
});

test('surfaces the specific reason inside an errors array', async () => {
  const message = await describeHttpFailure(response(422, JSON.stringify({
    message: 'Repository creation failed.',
    errors: [{ message: 'name already exists on this account' }]
  })), 'GitHub template generation');
  assert.match(message, /Repository creation failed\. — name already exists on this account/);
});

test('falls back to the raw body, then to nothing, without ever throwing', async () => {
  assert.match(await describeHttpFailure(response(502, '<html>bad gateway</html>'), 'x'),
    /HTTP 502: <html>bad gateway<\/html>/);
  assert.equal(await describeHttpFailure(response(500, ''), 'x'), 'x failed with HTTP 500');
  assert.equal(
    await describeHttpFailure({ status: 500, text: async () => { throw new Error('consumed'); } }, 'x'),
    'x failed with HTTP 500');
});

test('bounds the detail so a huge body cannot flood the terminal', async () => {
  const message = await describeHttpFailure(response(500, 'x'.repeat(5000)), 'y');
  assert.ok(message.length < 500, message.length);
  assert.match(message, /…$/);
});
