import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { verifyEmptyRepository, verifyRepositoryOrigin } from '../src/github-empty-repository.js';

function githubResponses(repository, branches = []) {
  const responses = [repository, branches];
  return async () => new Response(JSON.stringify(responses.shift()));
}

test('accepts only the exact existing repository with no branches or content', async () => {
  await verifyEmptyRepository({
    owner: 'rathnasgala', repository: 'smoke01', accessToken: 'token',
    fetchImpl: githubResponses({
      full_name: 'rathnasgala/smoke01', size: 0, pushed_at: '2026-08-12T09:50:33Z'
    })
  });
  await assert.rejects(verifyEmptyRepository({
    owner: 'rathnasgala', repository: 'smoke01', accessToken: 'token',
    fetchImpl: githubResponses({
      full_name: 'rathnasgala/smoke01', size: 1, pushed_at: '2026-08-12T00:00:00Z'
    })
  }), /not empty/);
});

test('rejects a repository with a branch even when GitHub reports size zero', async () => {
  await assert.rejects(verifyEmptyRepository({
    owner: 'rathnasgala', repository: 'smoke01', accessToken: 'token',
    fetchImpl: githubResponses({ full_name: 'rathnasgala/smoke01', size: 0 }, [{ name: 'main' }])
  }), /not empty/);
});

function originSpawn(origin, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end(`${origin}\n`);
      child.emit('exit', 0, null);
    });
    return child;
  };
}

test('accepts only the exact HTTPS origin for a resumed checkout', async () => {
  const calls = [];
  await verifyRepositoryOrigin({
    root: '/tmp/smoke01', owner: 'rathnasgala', repository: 'smoke01',
    spawnProcess: originSpawn('https://github.com/rathnasgala/smoke01.git', calls)
  });
  assert.deepEqual(calls[0].args, ['-C', '/tmp/smoke01', 'remote', 'get-url', 'origin']);
  assert.equal(calls[0].options.shell, false);
  await verifyRepositoryOrigin({
    root: '/tmp/smoke01', owner: 'rathnasgala', repository: 'smoke01',
    spawnProcess: originSpawn('https://operator:secret@github.com/rathnasgala/smoke01.git', [])
  });
  await assert.rejects(verifyRepositoryOrigin({
    root: '/tmp/smoke01', owner: 'rathnasgala', repository: 'smoke01',
    spawnProcess: originSpawn('https://github.com/rathnasgala/another.git', [])
  }), /origin must be/);
  for (const unsafeOrigin of [
    'http://github.com/rathnasgala/smoke01.git',
    'https://github.com:8443/rathnasgala/smoke01.git',
    'https://github.com/rathnasgala/smoke01.git?ref=main',
    'https://github.com/rathnasgala/smoke01.git#main',
    'https://example.com/rathnasgala/smoke01.git'
  ]) {
    await assert.rejects(verifyRepositoryOrigin({
      root: '/tmp/smoke01', owner: 'rathnasgala', repository: 'smoke01',
      spawnProcess: originSpawn(unsafeOrigin, [])
    }), /origin must be/);
  }
});
