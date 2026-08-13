import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { authenticateGithub } from '../src/github-auth-command.js';

function response(payload) { return { ok: true, status: 200, json: async () => payload }; }

test('explains broad scopes before device authorization and persists only the resulting token', async () => {
  const events = [];
  const payloads = [
    { device_code: 'device', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 },
    { access_token: 'token', token_type: 'bearer', scope: 'repo workflow' }
  ];
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'gala-github-auth-')), 'github.json');
  const result = await authenticateGithub({
    credentialTarget: target,
    fetchImpl: async () => response(payloads.shift()),
    sleep: async () => {}, now: () => 0,
    showScopeWarning: ({ explanation }) => events.push(explanation),
    showInstructions: ({ userCode }) => events.push(userCode)
  });
  assert.match(events[0], /every public and private repository/);
  assert.equal(events[1], 'ABCD-EFGH');
  assert.deepEqual(result.scopes, ['repo', 'workflow']);
});
