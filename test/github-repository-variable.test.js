import assert from 'node:assert/strict';
import test from 'node:test';

import { installRepositoryVariable } from '../src/github-repository-variable.js';

function response(status) {
  return { ok: status >= 200 && status < 300, status };
}

const input = {
  owner: 'author', repository: 'blog', accessToken: 'oauth-token',
  variableName: 'GALA_API_BASE_URL', variableValue: 'https://api.gala67.com'
};

test('updates an existing repository variable', async () => {
  const requests = [];
  await installRepositoryVariable({
    ...input,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(204);
    }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    name: 'GALA_API_BASE_URL', value: 'https://api.gala67.com'
  });
});

test('creates a repository variable when update reports it absent', async () => {
  const requests = [];
  await installRepositoryVariable({
    ...input,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(requests.length === 1 ? 404 : 201);
    }
  });
  assert.deepEqual(requests.map(({ options }) => options.method), ['PATCH', 'POST']);
});

test('provider errors disclose neither token nor variable value', async () => {
  await assert.rejects(
    installRepositoryVariable({ ...input, fetchImpl: async () => response(403) }),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.doesNotMatch(error.message, /oauth-token|api\.gala67\.com/);
      return true;
    }
  );
});
