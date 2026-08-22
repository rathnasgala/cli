import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GITHUB_APP_CLIENT_ID, authenticateGithub } from '../src/github-auth-command.js';

test('authenticates as the Gala GitHub App, negotiating no scopes at all', async () => {
  /*
   * The CLI used to authenticate as a separate OAuth App and request `repo` — read/write on every
   * repository the writer could reach — while the browser editor used the GitHub App. That single
   * difference is why the CLI could not list installations, was refused by organisations with OAuth
   * App restrictions, and inherited none of the App's grants.
   *
   * A GitHub App's permissions are fixed on the app and granted at installation, so a `scope`
   * parameter here asks for something the grant cannot express.
   */
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'gala-gh-app-')), 'github.json');
  const requests = [];
  let shown;

  const result = await authenticateGithub({
    credentialTarget: target,
    showInstructions: (instructions) => { shown = instructions; },
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      requests.push([String(url), new URLSearchParams(options.body)]);
      if (String(url).endsWith('/device/code')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            device_code: 'device', user_code: '1CED-B2D2',
            verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900
          })
        };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: 'ghu_token', token_type: 'bearer' })
      };
    }
  });

  assert.equal(requests[0][1].get('client_id'), GITHUB_APP_CLIENT_ID);
  assert.match(GITHUB_APP_CLIENT_ID, /^Iv/, 'a GitHub App client id, not an OAuth App one');
  assert.equal(requests[0][1].get('scope'), null, 'a GitHub App device flow takes no scope');
  assert.equal(shown.userCode, '1CED-B2D2');

  const stored = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.accessToken, 'ghu_token');
  assert.equal(stored.scopes, undefined, 'an App token has no scopes to record');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal(result.target, target);
});

test('requires somewhere to show the device instructions', async () => {
  await assert.rejects(authenticateGithub({}), /device instructions are required/);
});

test('records the eight-hour expiry and the refresh token that will renew it', async () => {
  /*
   * The app expires user tokens after eight hours and returns a refresh token with each. Exchanging
   * that refresh token needs the app's client secret, which lives on the server — so the CLI keeps
   * it for the API-side refresh, and in the meantime an expired credential asks for one sign-in
   * instead of failing as an unexplained 401 several calls deeper.
   */
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'gala-gh-exp-')), 'github.json');
  const issuedAt = Date.parse('2026-08-22T00:00:00.000Z');
  const result = await authenticateGithub({
    credentialTarget: target,
    showInstructions: () => {},
    sleep: async () => {},
    now: () => issuedAt,
    fetchImpl: async (url) => ({
      ok: true, status: 200,
      json: async () => String(url).endsWith('/device/code')
        ? {
          device_code: 'device', user_code: 'AAAA-1111',
          verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900
        }
        : {
          access_token: 'ghu_token', token_type: 'bearer',
          expires_in: 28800, refresh_token: 'ghr_token'
        }
    })
  });

  const stored = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(stored.accessToken, 'ghu_token');
  assert.equal(stored.expiresAt, '2026-08-22T08:00:00.000Z');
  assert.equal(stored.refreshToken, 'ghr_token');
  assert.equal(result.expiresAt.toISOString(), '2026-08-22T08:00:00.000Z');
});
