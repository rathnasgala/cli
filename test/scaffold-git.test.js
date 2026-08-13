import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { commitScaffold } from '../src/scaffold-git.js';

test('commits only generated configuration and workflow before pushing without a shell', async () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', args.includes('--quiet') ? 1 : 0, null));
    return child;
  };
  await commitScaffold('/site', { spawnProcess });
  assert.deepEqual(calls.map(({ args }) => args), [
    ['-C', '/site', 'add', '--', 'site.config.yml', '.github/workflows/publish.yml'],
    ['-C', '/site', 'diff', '--cached', '--quiet', '--exit-code'],
    ['-C', '/site', 'commit', '-m', 'chore(gala): configure site'],
    ['-C', '/site', 'push', 'origin', 'HEAD']
  ]);
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test('skips an empty retry commit but still retries the push', async () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  await commitScaffold('/site', { spawnProcess });
  assert.deepEqual(calls.map(({ args }) => args), [
    ['-C', '/site', 'add', '--', 'site.config.yml', '.github/workflows/publish.yml'],
    ['-C', '/site', 'diff', '--cached', '--quiet', '--exit-code'],
    ['-C', '/site', 'push', 'origin', 'HEAD']
  ]);
});
