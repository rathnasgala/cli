import assert from 'node:assert/strict';
import test from 'node:test';

import { galaCredentialAccepted } from '../src/gala-credential-health.js';

test('asks the server rather than trusting the file, and sends the credential as a bearer', async () => {
  const seen = [];
  const accepted = await galaCredentialAccepted({
    apiBaseUrl: 'https://api.gala67.com/',
    accessToken: 'gala-token',
    fetchImpl: async (url, init) => {
      seen.push([url, init]);
      return { status: 200 };
    }
  });

  assert.equal(accepted, true);
  assert.equal(seen[0][0], 'https://api.gala67.com/v1/me/sites');
  assert.equal(seen[0][1].headers.authorization, 'Bearer gala-token');
});

test('treats 401 as a finished credential', async () => {
  const accepted = await galaCredentialAccepted({
    apiBaseUrl: 'https://api.gala67.com',
    accessToken: 'legacy-token',
    fetchImpl: async () => ({ status: 401 })
  });
  assert.equal(accepted, false);
});

test('a 403 is an authorization answer, not a dead credential', async () => {
  // A reader who has never connected a repository gets 403 from this endpoint. Signing them out
  // over it would be a loop they cannot escape.
  const accepted = await galaCredentialAccepted({
    apiBaseUrl: 'https://api.gala67.com',
    accessToken: 'reader-token',
    fetchImpl: async () => ({ status: 403 })
  });
  assert.equal(accepted, true);
});

test('a network failure is not an answer, so it never forces a sign-in', async () => {
  const accepted = await galaCredentialAccepted({
    apiBaseUrl: 'https://api.gala67.com',
    accessToken: 'gala-token',
    fetchImpl: async () => { throw new Error('ENOTFOUND'); }
  });
  assert.equal(accepted, true);
});
