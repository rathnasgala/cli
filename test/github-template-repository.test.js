import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cloneRepository,
  generateRepositoryFromTemplate
} from '../src/github-template-repository.js';

function response(payload, status = 201) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

/**
 * Serves the generate call from `payload`, and the readiness poll that follows it from a
 * repository that already has a branch. Generation is asynchronous, so every successful generate
 * makes both calls.
 */
function generated(payload, status = 201) {
  let first = true;
  return async () => {
    if (first) {
      first = false;
      return response(payload, status);
    }
    return response([{ name: 'main' }], 200);
  };
}

test('generates a public repository from the configured template through the GitHub API', async () => {
  let request;
  const result = await generateRepositoryFromTemplate({
    accessToken: 'process-local-token',
    templateOwner: 'gala',
    templateRepository: 'site-template',
    owner: 'author',
    repository: 'notes',
    description: 'Engineering notes',
    fetchImpl: async (url, options) => {
      if (String(url).includes('/branches')) return response([{ name: 'main' }], 200);
      request = { url, options };
      return response({
        full_name: 'author/notes',
        clone_url: 'https://github.com/author/notes.git'
      });
    }
  });

  assert.equal(request.url, 'https://api.github.com/repos/gala/site-template/generate');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.authorization, 'Bearer process-local-token');
  assert.equal(request.options.headers['x-github-api-version'], '2026-03-10');
  assert.deepEqual(JSON.parse(request.options.body), {
    owner: 'author',
    name: 'notes',
    description: 'Engineering notes',
    include_all_branches: false,
    private: false
  });
  assert.deepEqual(result, {
    fullName: 'author/notes',
    cloneUrl: 'https://github.com/author/notes.git'
  });
});

test('rejects failed, unexpected, and unsafe GitHub repository responses', async () => {
  const options = {
    accessToken: 'token',
    templateOwner: 'gala',
    templateRepository: 'site-template',
    owner: 'author',
    repository: 'notes'
  };
  await assert.rejects(
    () => generateRepositoryFromTemplate({ ...options, fetchImpl: async () => response({}, 422) }),
    /HTTP 422/
  );
  await assert.rejects(
    () => generateRepositoryFromTemplate({
      ...options,
      fetchImpl: async () => response({
        full_name: 'attacker/notes',
        clone_url: 'https://github.com/attacker/notes.git'
      })
    }),
    /unexpected repository/
  );
  await assert.rejects(
    () => generateRepositoryFromTemplate({
      ...options,
      fetchImpl: async () => response({
        full_name: 'author/notes',
        clone_url: 'https://user:secret@github.com/author/notes.git'
      })
    }),
    /invalid clone_url/
  );
});

test('clones without a shell and reports process failure', async () => {
  let invocation;
  const cloneTarget = path.join(tmpdir(), 'gala-notes');
  const successfulSpawn = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  const target = await cloneRepository({
    cloneUrl: 'https://github.com/author/notes.git',
    target: cloneTarget,
    spawnProcess: successfulSpawn
  });
  assert.equal(target, path.resolve(cloneTarget));
  assert.equal(invocation.command, 'git');
  assert.deepEqual(invocation.args, [
    'clone',
    'https://github.com/author/notes.git',
    path.resolve(cloneTarget)
  ]);
  assert.equal(invocation.options.shell, false);

  await assert.rejects(
    () => cloneRepository({
      cloneUrl: 'https://github.com/author/notes.git',
      target: cloneTarget,
      spawnProcess: () => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('exit', 128, null));
        return child;
      }
    }),
    /code 128/
  );
});

test('a refused generation reports what GitHub said, not just that it was refused', async () => {
  /*
   * Driven with a real Response rather than a hand-written stub, because the whole point is that
   * the body survives — and a fake that omits clone()/text() would pass while the real thing
   * silently dropped the detail.
   *
   * This is the 403 a scaffold hits when the organisation owning the template has OAuth App access
   * restrictions on. "GitHub template generation failed with HTTP 403" is indistinguishable from a
   * missing scope, a rename or a rate limit; GitHub's own sentence is not.
   */
  const body = JSON.stringify({
    message: 'Although you appear to have the correct authorization credentials, the `rathnasgala` '
      + 'organization has enabled OAuth App access restrictions.',
    documentation_url: 'https://docs.github.com/articles/restricting-access-to-your-organization-s-data/'
  });

  await assert.rejects(
    generateRepositoryFromTemplate({
      accessToken: 'gho_token',
      templateOwner: 'rathnasgala',
      templateRepository: 'site-template',
      owner: 'saranfrog2',
      repository: 'cli67test',
      fetchImpl: async () => new Response(body, {
        status: 403, headers: { 'content-type': 'application/json' }
      })
    }),
    (error) => /HTTP 403/.test(error.message)
      && /OAuth App access restrictions/.test(error.message)
      && /docs\.github\.com/.test(error.message)
  );
});

test('waits for the generated repository to contain the template before returning', async () => {
  /*
   * Generating from a template is asynchronous. GitHub answered 201 with a clone URL and the
   * repository was still empty, so the clone produced "You appear to have cloned an empty
   * repository" and scaffolding died on a missing site.config.yml — a file the template certainly
   * contains. Readiness is a branch existing; `size` stayed 0 on a repository that already had
   * `main` and commits, so it cannot be used.
   */
  const calls = [];
  let branchLookups = 0;
  const result = await generateRepositoryFromTemplate({
    accessToken: 'gho_token',
    templateOwner: 'rathnasgala',
    templateRepository: 'site-template',
    owner: 'saranfrog2',
    repository: 'cli67test',
    sleep: async () => {},
    readinessIntervalMs: 0,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/generate')) {
        return new Response(JSON.stringify({
          full_name: 'saranfrog2/cli67test',
          clone_url: 'https://github.com/saranfrog2/cli67test.git'
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      branchLookups += 1;
      // Empty twice, then populated: exactly the race that broke the real run.
      return new Response(JSON.stringify(branchLookups < 3 ? [] : [{ name: 'main' }]),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  assert.equal(result.fullName, 'saranfrog2/cli67test');
  assert.equal(branchLookups, 3);
  assert.ok(calls.some((url) => url.includes('/branches?per_page=1')));
});

test('gives up on a template copy that never lands, and says what to do next', async () => {
  await assert.rejects(
    generateRepositoryFromTemplate({
      accessToken: 'gho_token',
      templateOwner: 'rathnasgala',
      templateRepository: 'site-template',
      owner: 'saranfrog2',
      repository: 'cli67test',
      sleep: async () => {},
      readinessAttempts: 3,
      readinessIntervalMs: 0,
      fetchImpl: async (url) => String(url).endsWith('/generate')
        ? new Response(JSON.stringify({
          full_name: 'saranfrog2/cli67test',
          clone_url: 'https://github.com/saranfrog2/cli67test.git'
        }), { status: 201, headers: { 'content-type': 'application/json' } })
        : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }),
    /still empty after .*--resume/s
  );
});
