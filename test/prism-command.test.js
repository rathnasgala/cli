import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const siteId = '01M0T5Z4FBK60HTS7FH8JK06QK';
const articleId = '01M0T5Z4FBK60HTS7FH8JK06QL';
const configurationId = '01M0T5Z4FBK60HTS7FH8JK06QM';
const revisionId = '01M0T5Z4FBK60HTS7FH8JK06QP';

test('Prism status and create use committed server state and an idempotency key', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-prism-'));
  const home = await mkdtemp(path.join(tmpdir(), 'gala-home-'));
  await writeFile(path.join(root, 'site.config.yml'), `site:\n  id: ${siteId}\n  defaultLanguage: en\nhosting:\n  canonicalBaseUrl: https://writer.github.io\n  pathPrefix: /notes\n`);

  const mutations = [];
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/v1/me/sites') {
      response.end(JSON.stringify([]));
      return;
    }
    if (request.method === 'GET' && request.url === `/v1/sites/${siteId}/prism`) {
      response.end(JSON.stringify({
        requestedMode: 'MANUAL', publishedMode: 'MANUAL',
        requestedConfigurationLinkPolicy: 'NOFOLLOW',
        publishedConfigurationLinkPolicy: 'NOFOLLOW',
      }));
      return;
    }
    if (request.method === 'GET' && request.url === `/v1/sites/${siteId}/posts`) {
      response.end(JSON.stringify({
        headSha: 'a'.repeat(40),
        posts: [{ slug: 'proof', language: 'en', articleId,
          path: 'content/posts/proof/index.en.md' }],
      }));
      return;
    }
    if (request.method === 'PUT' && request.url === `/v1/sites/${siteId}/prism`) {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      mutations.push({ headers: request.headers, body: parsed, method: request.method,
        url: request.url });
      if (parsed.mode === 'MANUAL') {
        response.statusCode = 409;
        response.end(JSON.stringify({ code: 'PRISM_SOURCE_CONFLICT',
          message: 'The repository changed; reload and review before retrying.' }));
      } else {
        response.statusCode = 202;
        response.end(JSON.stringify({
          settings: { requestedMode: parsed.mode, requestedConfigurationLinkPolicy: 'NOFOLLOW' },
          materialization: {
            materializationId: '01M0T5Z4FBK60HTS7FH8JK06QR', status: 'FAILED',
            operation: 'SETTINGS', attemptCount: 1, errorCode: 'PRISM_REPOSITORY_CONFLICT',
          },
        }));
      }
      return;
    }
    if (request.method === 'GET'
      && request.url === `/v1/sites/${siteId}/articles/${articleId}/configurations?language=en`) {
      response.end(JSON.stringify({
        sourceRevisionHash: 'b'.repeat(64), hashContract: 'GALA_PRISM_HASH_V1',
        configurations: [{
          configurationId, depth: 'BRIEF', intent: 'PROOF', modality: 'TEXT',
          lifecycle: 'DRAFT', deliveryState: 'NOT_EMITTED',
          workingRevision: {
            revisionId, reviewState: 'PROPOSED',
            literalFindings: [{
              id: 'warning-quote-1', severity: 'WARNING',
              message: 'Review the changed attribution.',
            }],
          },
        }],
      }));
      return;
    }
    if (request.method === 'POST'
      && request.url === `/v1/sites/${siteId}/articles/${articleId}/configurations`) {
      let body = '';
      for await (const chunk of request) body += chunk;
      mutations.push({ headers: request.headers, body: JSON.parse(body) });
      response.statusCode = 201;
      response.end(JSON.stringify({ configurationId }));
      return;
    }
    if (request.method === 'POST'
      && request.url === `/v1/sites/${siteId}/articles/${articleId}/configurations/${configurationId}/generation-jobs`) {
      let body = '';
      for await (const chunk of request) body += chunk;
      mutations.push({ headers: request.headers, body: JSON.parse(body), method: request.method,
        url: request.url });
      response.statusCode = 202;
      response.end(JSON.stringify({
        jobId: '01M0T5Z4FBK60HTS7FH8JK06QO', configurationId,
        sourceRevisionHash: 'b'.repeat(64), status: 'SUCCEEDED', attemptCount: 1,
        revisionId, createdAt: new Date().toISOString(),
      }));
      return;
    }
    if (request.method === 'POST'
      && request.url === `/v1/sites/${siteId}/articles/${articleId}/configurations/${configurationId}/submit`) {
      let body = '';
      for await (const chunk of request) body += chunk;
      mutations.push({ headers: request.headers, body: JSON.parse(body), method: request.method,
        url: request.url });
      response.end(JSON.stringify({ revisionId, reviewState: 'PROPOSED' }));
      return;
    }
    if (request.method === 'POST'
      && request.url === `/v1/sites/${siteId}/articles/${articleId}/configurations/${configurationId}/approve`) {
      let body = '';
      for await (const chunk of request) body += chunk;
      mutations.push({ headers: request.headers, body: JSON.parse(body), method: request.method,
        url: request.url });
      response.statusCode = 202;
      response.end(JSON.stringify({
        approval: { approvalId: '01M0T5Z4FBK60HTS7FH8JK06QS' },
        materialization: {
          materializationId: '01M0T5Z4FBK60HTS7FH8JK06QT', status: 'COMMITTED',
          operation: 'PUBLISH', attemptCount: 1, commitSha: 'd'.repeat(40),
        },
      }));
      return;
    }
    if (request.method === 'DELETE'
      && request.url === `/v1/sites/${siteId}/articles/${articleId}/prism?fields=configurationLinkPolicy`) {
      mutations.push({ headers: request.headers, body: null, method: request.method, url: request.url });
      response.statusCode = 202;
      response.end(JSON.stringify({
        settings: {
          requestedEffectiveMode: 'MANUAL',
          requestedEffectiveConfigurationLinkPolicy: 'NOFOLLOW',
        },
        materialization: {
          materializationId: '01M0T5Z4FBK60HTS7FH8JK06QN', status: 'COMMITTED',
          operation: 'SETTINGS', attemptCount: 1, commitSha: 'c'.repeat(40),
          publicationAttemptSha: 'c'.repeat(40),
        },
      }));
      return;
    }
    if (request.method === 'GET'
      && request.url === `/v1/sites/${siteId}/publication-attempts/${'c'.repeat(40)}`) {
      response.end(JSON.stringify({ status: 'PUBLISHED', commitSha: 'c'.repeat(40), errors: [] }));
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
  const credentialDirectory = path.join(home, 'Library', 'Application Support', 'Gala');
  await mkdir(credentialDirectory, { recursive: true });
  await writeFile(path.join(credentialDirectory, 'credentials.json'), `${JSON.stringify({
    schemaVersion: 2, accessToken: 'test-token', apiBaseUrl,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })}\n`);
  const invoke = (args) => run(process.execPath, [entry, ...args], {
    cwd: root, env: { ...process.env, HOME: home, NO_COLOR: '1' },
  });
  await run('git', ['init'], { cwd: root });

  const status = await invoke(['prism', 'status']);
  assert.match(status.stdout, /Prism MANUAL/);
  assert.match(status.stdout, /requested MANUAL; published MANUAL/);
  assert.doesNotMatch(status.stdout, /effective undefined/);

  const created = await invoke(['prism', 'create', 'proof', '--depth', 'brief',
    '--intent', 'proof']);
  assert.match(created.stdout, /01M0T5Z4FBK60HTS7FH8JK06QM/);
  assert.equal(mutations.length, 1);
  assert.match(mutations[0].headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(mutations[0].body, {
    language: 'en', depth: 'BRIEF', intent: 'PROOF', modality: 'TEXT',
    expectedSourceContentHash: 'b'.repeat(64), hashContract: 'GALA_PRISM_HASH_V1',
  });

  const generated = await invoke(['prism', 'generate', configurationId]);
  assert.match(generated.stdout, new RegExp(`Proposal revision ${revisionId} is ready for review`));
  assert.match(mutations[1].headers['idempotency-key'], /^[0-9a-f-]{36}$/);

  const submitted = await invoke(['prism', 'submit', configurationId, revisionId, '--yes']);
  assert.match(submitted.stdout, new RegExp(`${revisionId} PROPOSED`));
  assert.deepEqual(mutations[2].body.acknowledgedWarningIds, ['warning-quote-1']);

  const inherited = await invoke(['prism', 'link-policy', 'work', 'proof', 'inherit']);
  assert.match(inherited.stdout, /Queued 01M0T5Z4FBK60HTS7FH8JK06QN/);
  assert.match(inherited.stdout, /Published at https:\/\/writer.github.io\/notes/);
  assert.equal(mutations[3].url,
    `/v1/sites/${siteId}/articles/${articleId}/prism?fields=configurationLinkPolicy`);
  assert.equal(mutations[3].headers['x-expected-repository-head'], 'a'.repeat(40));
  assert.match(mutations[3].headers['idempotency-key'], /^[0-9a-f-]{36}$/);

  await assert.rejects(invoke(['prism', 'approve', configurationId, revisionId]), (error) => {
    assert.match(error.stderr, /no terminal to ask; pass it as an option instead/);
    assert.match(error.stdout, /Warning warning-quote-1: Review the changed attribution/);
    return true;
  });
  await assert.rejects(invoke([
    'prism', 'approve', configurationId, '01M0T5Z4FBK60HTS7FH8JK06QZ', '--yes',
  ]), (error) => {
    assert.match(error.stderr, /Only the current working revision can be approved/);
    assert.doesNotMatch(error.stdout, /Warning warning-quote-1/);
    return true;
  });
  const approved = await invoke(['prism', 'approve', configurationId, revisionId, '--yes']);
  assert.match(approved.stdout, /Repository updated/);
  assert.deepEqual(mutations[4].body.acknowledgedWarningIds, ['warning-quote-1']);
  assert.match(mutations[4].headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  await assert.rejects(invoke(['prism', 'mode', 'manual']), (error) => {
    assert.match(error.stderr, /repository changed; reload and review before retrying/);
    return true;
  });
  await assert.rejects(invoke(['prism', 'mode', 'assisted']), (error) => {
    assert.match(error.stderr, /Repository update failed \(PRISM_REPOSITORY_CONFLICT\)/);
    return true;
  });
});
