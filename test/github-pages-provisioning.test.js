import assert from 'node:assert/strict';
import test from 'node:test';

import { provisionGithubPages } from '../src/github-pages-provisioning.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}

const base = {
  owner: 'author', repository: 'blog', accessToken: 'oauth-token',
  commitSha: '0123456789abcdef0123456789abcdef01234567', pollIntervalMs: 0
};

test('waits for the exact successful run and activates Pages from gh-pages', async () => {
  const requests = [];
  let workflowPolls = 0;
  const result = await provisionGithubPages({
    ...base,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/actions/workflows/')) {
        workflowPolls += 1;
        return response({ workflow_runs: [{
          head_sha: base.commitSha, status: workflowPolls === 1 ? 'in_progress' : 'completed',
          conclusion: workflowPolls === 1 ? null : 'success', html_url: 'https://github.test/run/1'
        }] });
      }
      if (url.endsWith('/branches/gh-pages')) return response({ name: 'gh-pages' });
      if (url.endsWith('/pages') && options.method === 'GET') return response({}, 404);
      return response({ html_url: 'https://author.github.io/blog/' }, 201);
    }
  });
  assert.deepEqual(result, {
    created: true, url: 'https://author.github.io/blog/', runUrl: 'https://github.test/run/1'
  });
  assert.equal(workflowPolls, 2);
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
    source: { branch: 'gh-pages', path: '/' }
  });
});

test('accepts an existing matching Pages configuration without mutation', async () => {
  const methods = [];
  const result = await provisionGithubPages({
    ...base,
    fetchImpl: async (url, options) => {
      methods.push(options.method);
      if (url.includes('/actions/workflows/')) return response({ workflow_runs: [{
        head_sha: base.commitSha, status: 'completed', conclusion: 'success', html_url: 'run'
      }] });
      if (url.endsWith('/branches/gh-pages')) return response({ name: 'gh-pages' });
      return response({ source: { branch: 'gh-pages', path: '/' }, html_url: 'site' });
    }
  });
  assert.deepEqual(result, { created: false, url: 'site', runUrl: 'run' });
  assert.deepEqual(methods, ['GET', 'GET', 'GET']);
});

test('sets an explicit custom domain after creating Pages and converges on retry', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/actions/workflows/')) return response({ workflow_runs: [{
      head_sha: base.commitSha, status: 'completed', conclusion: 'success', html_url: 'run'
    }] });
    if (url.endsWith('/branches/gh-pages')) return response({ name: 'gh-pages' });
    if (url.endsWith('/pages') && options.method === 'GET') return response({}, 404);
    if (url.endsWith('/pages') && options.method === 'POST') {
      return response({ html_url: 'https://author.github.io/blog/' }, 201);
    }
    if (url.endsWith('/pages') && options.method === 'PUT') return response(null, 204);
    throw new Error(`Unexpected request ${options.method} ${url}`);
  };
  await provisionGithubPages({ ...base, customDomain: 'smoke.gala67.com', fetchImpl });
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
    cname: 'smoke.gala67.com', source: { branch: 'gh-pages', path: '/' }
  });
});

test('updates a mismatched existing custom domain but leaves a matching one untouched', async () => {
  for (const [existing, expectedMethods] of [
    [null, ['GET', 'GET', 'GET', 'PUT']],
    ['smoke.gala67.com', ['GET', 'GET', 'GET']]
  ]) {
    const methods = [];
    await provisionGithubPages({
      ...base, customDomain: 'smoke.gala67.com',
      fetchImpl: async (url, options) => {
        methods.push(options.method);
        if (url.includes('/actions/workflows/')) return response({ workflow_runs: [{
          head_sha: base.commitSha, status: 'completed', conclusion: 'success', html_url: 'run'
        }] });
        if (url.endsWith('/branches/gh-pages')) return response({ name: 'gh-pages' });
        if (options.method === 'PUT') return response(null, 204);
        return response({ source: { branch: 'gh-pages', path: '/' }, cname: existing, html_url: 'site' });
      }
    });
    assert.deepEqual(methods, expectedMethods);
  }
});

test('reports the failed matching workflow URL and never activates Pages', async () => {
  await assert.rejects(
    provisionGithubPages({
      ...base,
      fetchImpl: async () => response({ workflow_runs: [{
        head_sha: base.commitSha, status: 'completed', conclusion: 'failure',
        html_url: 'https://github.test/run/failed'
      }] })
    }),
    /Initial publish workflow failed: https:\/\/github\.test\/run\/failed/
  );
});

test('times out when the matching run never appears', async () => {
  await assert.rejects(
    provisionGithubPages({
      ...base, maxPolls: 2, sleep: async () => {},
      fetchImpl: async () => response({ workflow_runs: [] })
    }),
    /Timed out waiting for the publish workflow/
  );
});
