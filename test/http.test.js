import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpError, request } from '../src/api/http.js';

const original = globalThis.fetch;
function answering(status, body, headers = { 'content-type': 'application/json' }) {
  globalThis.fetch = async () => new Response(body, { status, headers });
}
test.afterEach(() => { globalThis.fetch = original; });

test('carries the reason the server gave, which is the only place it appears', async () => {
  /*
   * v0 reported `failed with HTTP 403` and discarded the body at all twenty failure sites. GitHub
   * distinguishes an organisation's OAuth App restrictions from a missing permission, a rename and
   * a rate limit in that body and nowhere else, so diagnosing anything meant guessing between
   * causes the server had already told us apart.
   */
  answering(403, JSON.stringify({
    message: 'Although you appear to have the correct authorization credentials, the `acme` '
      + 'organization has enabled OAuth App access restrictions.',
    documentation_url: 'https://docs.github.com/articles/restricting-access'
  }));
  await assert.rejects(request('https://api.github.com/x', { action: 'Repository creation' }),
    (error) => error instanceof HttpError
      && error.status === 403
      && /OAuth App access restrictions/.test(error.message)
      && /See https:\/\/docs\.github\.com/.test(error.message));
});

test('surfaces the specific reason inside an errors array', async () => {
  answering(422, JSON.stringify({
    message: 'Repository creation failed.',
    errors: [{ message: 'name already exists on this account' }]
  }));
  await assert.rejects(request('https://api.github.com/x', { action: 'Repository creation' }),
    /Repository creation failed\. — name already exists on this account/);
});

test('keeps the API error code so a caller can branch on it', async () => {
  answering(409, JSON.stringify({ code: 'GITHUB_APP_NOT_INSTALLED', message: 'not installed' }));
  await assert.rejects(request('https://api.gala67.com/x', { action: 'Registration' }),
    (error) => error.code === 'GITHUB_APP_NOT_INSTALLED' && /not installed/.test(error.message));
});

test('falls back to the raw body, then to the status, without ever throwing itself', async () => {
  answering(502, '<html>bad gateway</html>', { 'content-type': 'text/html' });
  await assert.rejects(request('https://x.test/y', { action: 'Lookup' }), /bad gateway/);

  answering(500, '');
  await assert.rejects(request('https://x.test/y', { action: 'Lookup' }), /Lookup failed with HTTP 500/);
});

test('bounds the detail so a huge body cannot flood the terminal', async () => {
  answering(500, JSON.stringify({ message: 'x'.repeat(5000) }));
  await assert.rejects(request('https://x.test/y', { action: 'Lookup' }),
    (error) => error.message.length < 500 && error.message.endsWith('…'));
});

test('an unreachable host names the host rather than leaking a socket error', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(request('https://api.gala67.com/v1/x', { action: 'Sign-in' }),
    /Sign-in could not reach api\.gala67\.com/);
});
