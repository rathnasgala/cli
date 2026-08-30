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
  let publicationUrl = 'https://writer.github.io/notes/';
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/v1/me/sites') {
      response.end(JSON.stringify([{
        siteId, repository: 'writer/notes', publicationUrl,
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
      const removing = publicationUrl === 'https://blog.example.com/';
      pending = {
        changeId,
        state: 'PREPARED',
        canonicalBaseUrl: removing ? 'https://writer.github.io' : 'https://blog.example.com',
        pathPrefix: removing ? '/notes' : '/',
        cname: removing ? null : 'blog.example.com',
        configuredAt: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        committedAt: null,
      };
      response.end(JSON.stringify(pending));
      return;
    }
    if (request.method === 'DELETE'
        && request.url === `/v1/sites/${siteId}/topology-changes/${changeId}`) {
      pending = null;
      response.statusCode = 204;
      response.end();
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
      publicationUrl = pending.cname
        ? `https://${pending.cname}/`
        : 'https://writer.github.io/notes/';
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
  assert.match(status.stdout, /writer\.github\.io\/notes/);
  assert.match(status.stdout, /No domain change is pending/);

  configureFailure = { code: 'GITHUB_PAGES_DOMAIN_VERIFICATION_REQUIRED', remaining: 5 };
  const reserved = await invoke(['domain', 'set', 'blog.example.com']);
  assert.match(reserved.stdout, /Reserved blog\.example\.com/);
  assert.match(reserved.stdout, /publishing remains safe while ownership verification is pending/);
  assert.match(reserved.stdout, /GitHub owner @writer must verify blog\.example\.com once/);
  assert.match(reserved.stdout, /github\.com\/organizations\/writer\/settings\/pages/);
  assert.match(reserved.stdout, /_github-pages-challenge-writer\.blog\.example\.com/);
  assert.match(reserved.stdout, /domain check/);
  assert.match(reserved.stdout,
    /reader sign-in, comments, reactions, and view tracking are unavailable/);

  await assert.rejects(invoke(['domain', 'set', 'other.example.com']), (failure) => {
    assert.match(failure.stderr, /A change to https:\/\/blog\.example\.com\/ is already pending/);
    assert.match(failure.stderr, /domain cancel/);
    return true;
  });
  const cancelled = await invoke(['domain', 'cancel']);
  assert.match(cancelled.stdout, /Cancelled the pending domain change/);
  assert.match(cancelled.stdout, /publication source were restored/);

  configureFailure = { code: 'GITHUB_PAGES_DOMAIN_PROPAGATION_PENDING', remaining: 2 };
  commitFailure = 'GITHUB_PAGES_DNS_PENDING';
  const configured = await invoke(['domain', 'set', 'blog.example.com']);
  assert.match(configured.stdout, /Waiting for GitHub Pages to finish applying the domain/);
  assert.match(configured.stdout, /GitHub verified and accepted blog\.example\.com/);
  assert.match(configured.stdout, /DNS action required/);
  assert.match(configured.stdout, /CNAME blog\.example\.com → writer\.github\.io/);
  assert.match(configured.stdout,
    /Until .*domain check.* reports the domain is live, reader sign-in, comments, reactions, and view tracking are unavailable/);
  assert.equal(pending.state, 'PAGES_CONFIGURED');

  const pendingStatus = await invoke(['domain', 'status']);
  assert.match(pendingStatus.stdout, /DNS, certificate, or HTTPS activation is pending/);
  assert.match(pendingStatus.stdout, /reader sign-in, comments, reactions, and view tracking are unavailable/);

  const dnsPending = await invoke(['domain', 'check']);
  assert.match(dnsPending.stdout, /CNAME blog\.example\.com → writer\.github\.io/);
  const commitFailures = [
    ['GITHUB_PAGES_DNS_INVALID', /Correct them, then run: .*domain check/,
      /CNAME blog\.example\.com → writer\.github\.io/],
    ['GITHUB_PAGES_PERMISSION_REQUIRED', /needs Pages and Administration access to writer\/notes/,
      /github\.com\/organizations\/writer\/settings\/installations/],
    ['GITHUB_PAGES_DOMAIN_REJECTED', /GitHub rejected blog\.example\.com/,
      /github\.com\/writer\/notes\/settings\/pages/],
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
  const expectedWaits = [
    ['GITHUB_PAGES_CERTIFICATE_PENDING', /provisioning the HTTPS certificate/],
    ['GITHUB_PAGES_TOPOLOGY_NOT_READY', /finishing HTTPS and the final address/],
    ['GITHUB_PAGES_VERIFICATION_UNAVAILABLE', /pending change is preserved/],
  ];
  for (const [code, outputPattern] of expectedWaits) {
    commitFailure = code;
    const waiting = await invoke(['domain', 'check']);
    assert.match(waiting.stdout, outputPattern);
    assert.match(waiting.stdout,
      /reader sign-in, comments, reactions, and view tracking are unavailable/);
  }
  commitFailure = null;
  const committed = await invoke(['domain', 'check']);
  assert.match(committed.stdout, /https:\/\/blog\.example\.com\/ is live with enforced HTTPS/);
  assert.equal(pending, null);
  const completed = await invoke(['domain', 'check']);
  assert.match(completed.stdout, /https:\/\/blog\.example\.com/);
  assert.match(completed.stdout, /No domain change is pending/);
  const alreadyLive = await invoke(['domain', 'set', 'blog.example.com']);
  assert.match(alreadyLive.stdout, /already this publication’s configured address/);
  const removed = await invoke(['domain', 'remove']);
  assert.match(removed.stdout, /GitHub Pages address is live again/);
  assert.match(removed.stdout, /Remove the old custom-domain records/);
  const alreadyRemoved = await invoke(['domain', 'remove']);
  assert.match(alreadyRemoved.stdout, /already this publication’s configured address/);
  assert.equal(calls.filter((call) => call.endsWith('/configure')).length, 8);
  assert.equal(calls.filter((call) => call.endsWith('/commit')).length, 11);
});
