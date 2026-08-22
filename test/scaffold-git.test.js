import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { commitScaffold } from '../src/scaffold-git.js';

test('commits only the site configuration, which is the one file the CLI still owns', async () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      if (args.includes('rev-parse')) child.stdout.emit('data', '0123456789abcdef0123456789abcdef01234567\n');
      child.emit('exit', args.includes('--quiet') ? 1 : 0, null);
    });
    return child;
  };
  assert.equal(await commitScaffold('/site', { spawnProcess }), '0123456789abcdef0123456789abcdef01234567');
  assert.deepEqual(calls.map(({ args }) => args), [
    ['-C', '/site', 'add', '--', 'site.config.yml'],
    ['-C', '/site', 'diff', '--cached', '--quiet', '--exit-code'],
    ['-C', '/site', 'commit', '-m', 'chore(gala): configure site'],
    ['-C', '/site', 'push', 'origin', 'HEAD'],
    ['-C', '/site', 'rev-parse', 'HEAD']
  ]);
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test('skips an empty retry commit but still retries the push', async () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      if (args.includes('rev-parse')) child.stdout.emit('data', '0123456789abcdef0123456789abcdef01234567\n');
      child.emit('exit', 0, null);
    });
    return child;
  };
  await commitScaffold('/site', { spawnProcess });
  assert.deepEqual(calls.map(({ args }) => args), [
    ['-C', '/site', 'add', '--', 'site.config.yml'],
    ['-C', '/site', 'diff', '--cached', '--quiet', '--exit-code'],
    ['-C', '/site', 'push', 'origin', 'HEAD'],
    ['-C', '/site', 'rev-parse', 'HEAD']
  ]);
});
