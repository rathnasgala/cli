import assert from 'node:assert/strict';
import test from 'node:test';

import { installRepositorySecret } from '../src/github-repository-secret.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}

test('fetches a fresh repository key, awaits sodium, seals, and uploads without plaintext', async () => {
  const requests = [];
  let readyResolved = false;
  let resolveReady;
  const sodium = {
    ready: new Promise((resolve) => {
      resolveReady = () => {
        readyResolved = true;
        resolve();
      };
    }),
    from_base64(value) {
      assert.equal(value, 'cmVwb3NpdG9yeS1rZXk=');
      return Uint8Array.from([1, 2, 3]);
    },
    from_string(value) {
      assert.equal(readyResolved, true);
      assert.equal(value, 'live-site-secret');
      return Uint8Array.from([4, 5, 6]);
    },
    crypto_box_seal(message, publicKey) {
      assert.deepEqual(message, Uint8Array.from([4, 5, 6]));
      assert.deepEqual(publicKey, Uint8Array.from([1, 2, 3]));
      return Uint8Array.from([7, 8, 9]);
    },
    to_base64(ciphertext) {
      assert.deepEqual(ciphertext, Uint8Array.from([7, 8, 9]));
      return 'sealed-value';
    }
  };

  const operation = installRepositorySecret({
    owner: 'author',
    repository: 'blog',
    accessToken: 'oauth-token',
    secretName: 'GALA_SITE_SECRET',
    secretValue: 'live-site-secret',
    sodiumImpl: sodium,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'GET') {
        return response({ key_id: 'fresh-key-id', key: 'cmVwb3NpdG9yeS1rZXk=' });
      }
      return response(null, 204);
    }
  });

  assert.equal(requests.length, 0);
  resolveReady();
  await operation;

  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    encrypted_value: 'sealed-value',
    key_id: 'fresh-key-id'
  });
  assert.doesNotMatch(requests[1].options.body, /live-site-secret|oauth-token/);
  assert.equal(requests[0].options.headers.authorization, 'Bearer oauth-token');
});

test('errors disclose neither access token nor secret value', async () => {
  const options = {
    owner: 'author',
    repository: 'blog',
    accessToken: 'oauth-token',
    secretName: 'GALA_SITE_SECRET',
    secretValue: 'live-site-secret',
    sodiumImpl: { ready: Promise.resolve() },
    fetchImpl: async () => response({ message: 'provider echoed live-site-secret' }, 403)
  };

  await assert.rejects(
    () => installRepositorySecret(options),
    (error) => {
      assert.doesNotMatch(error.message, /live-site-secret|oauth-token|provider echoed/);
      assert.match(error.message, /HTTP 403/);
      return true;
    }
  );
});
