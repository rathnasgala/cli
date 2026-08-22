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
  return { status, json: async () => payload };
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
