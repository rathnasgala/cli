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
  let configureFailure = null;
  let commitFailure = null;
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
      if (configureFailure) {
        const code = configureFailure.code;
        configureFailure.remaining -= 1;
        if (configureFailure.remaining === 0) configureFailure = null;
        response.statusCode = 409;
        response.end(JSON.stringify({
          code,
          message: 'GitHub Pages has not finished this step',
        }));
        return;
      }
      pending = { ...pending, state: 'PAGES_CONFIGURED' };
      response.end(JSON.stringify(pending));
      return;
    }
    if (request.method === 'POST'
        && request.url === `/v1/sites/${siteId}/topology-changes/${changeId}/commit`) {
      if (commitFailure) {
        response.statusCode = 409;
        response.end(JSON.stringify({ code: commitFailure, message: 'GitHub DNS is pending' }));
        return;
      }
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

  configureFailure = { code: 'GITHUB_PAGES_DOMAIN_VERIFICATION_REQUIRED', remaining: 5 };
  await assert.rejects(invoke(['domain', 'check']), (failure) => {
    assert.match(failure.stdout, /Settings → Pages → Verified domains/);
    assert.match(failure.stdout, /GitHub supplies its value/);
    assert.match(failure.stderr, /GitHub still reports blog\.example\.com as unverified for @writer/);
    return true;
  });
  configureFailure = { code: 'GITHUB_PAGES_DOMAIN_PROPAGATION_PENDING', remaining: 2 };
  const configured = await invoke(['domain', 'check']);
  assert.match(configured.stdout, /Waiting for GitHub Pages to finish applying the domain/);
  assert.match(configured.stdout, /GitHub verified blog\.example\.com/);
  assert.equal(pending.state, 'PAGES_CONFIGURED');

  commitFailure = 'GITHUB_PAGES_DNS_PENDING';
  await assert.rejects(invoke(['domain', 'check']), (failure) => {
    assert.match(failure.stdout, /CNAME blog\.example\.com → writer\.github\.io/);
    assert.match(failure.stderr, /still checking DNS/);
    return true;
  });
  const commitFailures = [
    ['GITHUB_PAGES_DNS_INVALID', /Correct them, then run: .*domain check/,
      /CNAME blog\.example\.com → writer\.github\.io/],
    ['GITHUB_PAGES_PERMISSION_REQUIRED', /needs Pages and Administration access to writer\/notes/,
      /github\.com\/organizations\/writer\/settings\/installations/],
    ['GITHUB_PAGES_DOMAIN_REJECTED', /GitHub rejected blog\.example\.com/,
      /github\.com\/writer\/notes\/settings\/pages/],
    ['GITHUB_PAGES_TOPOLOGY_NOT_READY', /has not finished applying blog\.example\.com/],
    ['GITHUB_PAGES_VERIFICATION_UNAVAILABLE', /pending change is preserved/],
    ['SITE_TOPOLOGY_STATE_CONFLICT', /Inspect it with: .*domain status/],
  ];
  for (const [code, errorPattern, outputPattern] of commitFailures) {
    commitFailure = code;
    await assert.rejects(invoke(['domain', 'check']), (failure) => {
      assert.match(failure.stderr, errorPattern);
      if (outputPattern) assert.match(failure.stdout, outputPattern);
      return true;
    });
  }
  commitFailure = null;
  const committed = await invoke(['domain', 'check']);
  assert.match(committed.stdout, /blog\.example\.com is live with enforced HTTPS/);
  assert.equal(pending, null);
  assert.equal(calls.filter((call) => call.endsWith('/configure')).length, 8);
  assert.equal(calls.filter((call) => call.endsWith('/commit')).length, 8);
});
