import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { cloneRepository, createGit } from '../src/git.js';

function recorder({ exit = 0, stdout = '' } = {}) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      if (stdout !== '') child.stdout.emit('data', stdout);
      child.emit('exit', typeof exit === 'function' ? exit(args) : exit, null);
    });
    return child;
  };
  return { calls, spawnProcess };
}

test('runs as the writer, overriding whatever credential the machine has', async () => {
  /*
   * v0 let git fall through to the machine's credential helper, a different identity from the one
   * the CLI authenticated with. On the machine where this surfaced the token belonged to one
   * account and git's stored credential to another, so a publication was created through the API
   * and then refused when the CLI tried to write to it.
   */
  const { calls, spawnProcess } = recorder({ stdout: 'main\n' });
  await createGit({ root: '/site', token: 'ghu_secret', spawnProcess }).branch();

  const { args, options } = calls[0];
  // The empty helper comes first, or the machine's keychain answers before ours does.
  assert.equal(args[2], '-c');
  assert.equal(args[3], 'credential.helper=');
  assert.match(args[5], /username=x-access-token/);
  assert.equal(options.shell, false);
  assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
});

test('never puts the token where another process can read it', async () => {
  // Arguments are visible machine-wide through `ps`; another process's environment is not.
  const { calls, spawnProcess } = recorder({ stdout: 'main\n' });
  await createGit({ root: '/site', token: 'ghu_secret', spawnProcess }).branch();

  assert.ok(!calls[0].args.some((argument) => argument.includes('ghu_secret')), calls[0].args.join(' '));
  assert.equal(calls[0].options.env.GALA_GIT_TOKEN, 'ghu_secret');
});

test('without a token nothing is overridden, so ordinary clones still work', async () => {
  const { calls, spawnProcess } = recorder();
  await cloneRepository({ url: 'https://github.com/ada/notes.git', target: '/tmp/notes', spawnProcess });
  assert.deepEqual(calls[0].args, ['clone', 'https://github.com/ada/notes.git', '/tmp/notes']);
  assert.equal(calls[0].options.env, process.env);
});

test('records only when there is something to record', async () => {
  // An empty commit is noise in the writer's history and triggers a pointless publish run.
  const unchanged = recorder({ exit: (args) => (args.includes('--quiet') ? 0 : 0) });
  assert.equal(await createGit({ root: '/site', spawnProcess: unchanged.spawnProcess })
    .record('Publish', ['.']), false);
  assert.ok(!unchanged.calls.some(({ args }) => args.includes('-m')));

  const changed = recorder({ exit: (args) => (args.includes('--quiet') ? 1 : 0) });
  assert.equal(await createGit({ root: '/site', spawnProcess: changed.spawnProcess })
    .record('Publish', ['.']), true);
  assert.ok(changed.calls.some(({ args }) => args.includes('-m')));
});

test('refuses a detached checkout instead of guessing a branch', async () => {
  const { spawnProcess } = recorder({ stdout: 'HEAD\n' });
  await assert.rejects(createGit({ root: '/site', spawnProcess }).branch(), /not on a named branch/);
});

test('refuses an unusable commit id rather than reporting it', async () => {
  const { spawnProcess } = recorder({ stdout: 'not-a-sha\n' });
  await assert.rejects(createGit({ root: '/site', spawnProcess }).head(), /unusable commit id/);
});
