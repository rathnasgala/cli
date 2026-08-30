import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { credentialEnvironment } from './credential-fixture.js';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const siteId = '01M0T5Z4FBK60HTS7FH8JK06QK';
const changeId = '01M0T6A7GCN71JUT8GI9KL17RL';

test('domain reads server state and advances configure before commit', { timeout: 15_000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-domain-'));
  const home = await mkdtemp(path.join(tmpdir(), 'gala-home-'));
  await writeFile(path.join(root, 'site.config.yml'), `site:\n  id: ${siteId}\nhosting:\n  canonicalBaseUrl: https://writer.github.io\n  pathPrefix: /notes\n`);

  let pending = null;
  let verificationRequired = false;
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/v1/me/sites') {
      response.end(JSON.stringify([{
        siteId, repository: 'writer/notes', publicationUrl: 'https://blog.example.com',
      }]));
      return;
    }
    if (request.method === 'GET'
        && request.url === `/v1/sites/${siteId}/topology-changes/pending`) {
      if (!pending) {
        response.statusCode = 204;
        response.end();
      } else response.end(JSON.stringify(pending));
      return;
    }
    if (request.method === 'POST'
        && request.url === `/v1/sites/${siteId}/topology-changes/prepare`) {
      pending = {
        changeId,
        state: 'PREPARED',
        canonicalBaseUrl: 'https://blog.example.com',
        pathPrefix: '/',
        cname: 'blog.example.com',
        configuredAt: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        committedAt: null,
      };
      response.end(JSON.stringify(pending));
      return;
    }
    if (request.method === 'POST'
        && request.url === `/v1/sites/${siteId}/topology-changes/${changeId}/configure`) {
      if (verificationRequired) {
        response.statusCode = 409;
        response.end(JSON.stringify({
          code: 'GITHUB_PAGES_DOMAIN_VERIFICATION_REQUIRED',
          message: 'Verify this domain in the repository owner\'s GitHub account, then try again',
        }));
        return;
      }
      pending = { ...pending, state: 'PAGES_CONFIGURED' };
      response.end(JSON.stringify(pending));
      return;
    }
    if (request.method === 'POST'
        && request.url === `/v1/sites/${siteId}/topology-changes/${changeId}/commit`) {
      response.end(JSON.stringify({ ...pending, state: 'COMMITTED' }));
      pending = null;
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;
  const environment = await credentialEnvironment(home, {
    accessToken: 'test-token',
    apiBaseUrl,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  const invoke = (args) => run(process.execPath, [entry, ...args, '--account', 'test'], {
    cwd: root,
    env: environment,
  });

  const status = await invoke(['domain', 'status']);
  assert.match(status.stdout, /https:\/\/blog\.example\.com/);
  assert.doesNotMatch(status.stdout, /writer\.github\.io\/notes/);

  const reserved = await invoke(['domain', 'set', 'blog.example.com']);
  assert.match(reserved.stdout, /GitHub owner @writer must verify blog\.example\.com once/);
  assert.match(reserved.stdout, /github\.com\/organizations\/writer\/settings\/pages/);
  assert.match(reserved.stdout, /_github-pages-challenge-writer\.blog\.example\.com/);
  assert.match(reserved.stdout, /domain check/);

  verificationRequired = true;
  await assert.rejects(invoke(['domain', 'check']), (failure) => {
    assert.match(failure.stdout, /Settings → Pages → Verified domains/);
    assert.match(failure.stdout, /GitHub supplies its value/);
    assert.match(failure.stderr, /GitHub has not verified blog\.example\.com for @writer yet/);
    return true;
  });
  verificationRequired = false;
  const configured = await invoke(['domain', 'check']);
  assert.match(configured.stdout, /GitHub verified blog\.example\.com/);
  assert.equal(pending.state, 'PAGES_CONFIGURED');

  const committed = await invoke(['domain', 'check']);
  assert.match(committed.stdout, /blog\.example\.com is live with enforced HTTPS/);
  assert.equal(pending, null);
  assert.deepEqual(calls.filter((call) => call.includes(`/topology-changes/${changeId}/`)), [
    `POST /v1/sites/${siteId}/topology-changes/${changeId}/configure`,
    `POST /v1/sites/${siteId}/topology-changes/${changeId}/configure`,
    `POST /v1/sites/${siteId}/topology-changes/${changeId}/commit`,
  ]);
});
