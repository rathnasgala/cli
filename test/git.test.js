import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cloneRepository, createGit, populateEmptyRepository } from '../src/git.js';
import { runTemporaryGit, spawnTemporaryGit } from './temporary-git.js';

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

test('refuses unresolved conflicts before fetching or rebasing and names every file', async () => {
  const calls = [];
  const responses = [
    { exit: 0, stdout: 'content/posts/example/index.en.md\0site.config.yml\0' },
  ];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const response = responses.shift();
      if (response.stdout) child.stdout.emit('data', response.stdout);
      child.emit('exit', response.exit, null);
    });
    return child;
  };

  await assert.rejects(
    createGit({ root: '/site', spawnProcess }).takeRemote(),
    (failure) => {
      assert.equal(failure.message,
        'Git has unresolved conflicts. Gala left them untouched. Run git status, resolve or abort '
        + 'the operation it reports, then publish again.');
      assert.equal(failure.detail,
        'Conflicted files:\ncontent/posts/example/index.en.md\nsite.config.yml');
      return true;
    }
  );

  assert.deepEqual(calls.map(({ args }) => args.slice(2)), [
    ['diff', '--name-only', '--diff-filter=U', '-z'],
  ]);
  assert.ok(!calls.some(({ args }) => args.includes('fetch')));
  assert.ok(!calls.some(({ args }) => args.includes('rebase')));
});

test('leaves a real conflicted worktree and its unmerged index byte-for-byte untouched', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-conflicted-publication-'));
  const git = (...args) => runTemporaryGit(['-C', root, ...args]);
  const article = path.join(root, 'index.en.md');

  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Gala test');
  await git('config', 'user.email', 'test@gala.invalid');
  await writeFile(article, 'base\n');
  await git('add', 'index.en.md');
  await git('commit', '-m', 'base');
  await git('checkout', '-b', 'remote-change');
  await writeFile(article, 'remote\n');
  await git('commit', '-am', 'remote');
  await git('checkout', 'main');
  await writeFile(article, 'local\n');
  await git('commit', '-am', 'local');
  await assert.rejects(git('merge', 'remote-change'));

  const beforeBody = await readFile(article);
  const beforeIndex = (await git('ls-files', '--unmerged')).stdout;

  await assert.rejects(
    createGit({ root, spawnProcess: spawnTemporaryGit }).takeRemote(),
    /Git has unresolved conflicts/
  );

  assert.deepEqual(await readFile(article), beforeBody);
  assert.equal((await git('ls-files', '--unmerged')).stdout, beforeIndex);
  assert.match(beforeBody.toString(), /<<<<<<< HEAD/);
});

test('a clean checkout still fetches and rebases its named branch', async () => {
  const calls = [];
  const responses = [
    { exit: 0, stdout: '' },
    { exit: 0, stdout: 'main\n' },
    { exit: 0, stdout: '' },
    { exit: 0, stdout: '' },
    { exit: 0, stdout: '' },
    { exit: 0, stdout: `${'a'.repeat(40)}\n` },
  ];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const response = responses.shift();
      if (response.stdout) child.stdout.emit('data', response.stdout);
      child.emit('exit', response.exit, null);
    });
    return child;
  };

  assert.equal(await createGit({ root: '/site', spawnProcess }).takeRemote(), 'a'.repeat(40));
  assert.deepEqual(calls.map(({ args }) => args.slice(2)), [
    ['diff', '--name-only', '--diff-filter=U', '-z'],
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    ['fetch', 'origin', 'main'],
    ['rebase', '--autostash', 'origin/main'],
    ['diff', '--name-only', '--diff-filter=U', '-z'],
    ['rev-parse', 'HEAD'],
  ]);
});

test('stops after a successful autostash rebase that leaves conflicts', async () => {
  const calls = [];
  const responses = [
    { exit: 0, stdout: '' },
    { exit: 0, stdout: 'main\n' },
    { exit: 0, stdout: '' },
    { exit: 0, stdout: '' },
    { exit: 0, stdout: 'site.config.yml\0src/assets/reader.js\0' },
  ];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const response = responses.shift();
      if (response.stdout) child.stdout.emit('data', response.stdout);
      child.emit('exit', response.exit, null);
    });
    return child;
  };

  await assert.rejects(
    createGit({ root: '/site', spawnProcess }).takeRemote(),
    (failure) => {
      assert.match(failure.message, /could not reapply your local work without conflicts/);
      assert.equal(failure.detail, 'Conflicted files:\nsite.config.yml\nsrc/assets/reader.js');
      return true;
    }
  );
  assert.ok(!calls.some(({ args }) => args.slice(-2).join(' ') === 'rev-parse HEAD'));
});

test('refuses managed conflict recovery when local bytes fail their manifest hash', async () => {
  const responses = [
    { exit: 0, stdout: '' },
    { exit: 0, stdout: 'main\n' },
    { exit: 0, stdout: '' },
    { exit: 0, stdout: '' },
    { exit: 0, stdout: '.gala/managed-files.json\0site.config.yml\0src/assets/reader.js\0' },
    { exit: 0, stdout: JSON.stringify({ schemaVersion: 1,
      themePackage: { name: '@rathnasgala/theme', version: '3.0.0' },
      files: { 'src/assets/reader.js': '0'.repeat(64) } }) },
    { exit: 0, stdout: 'tampered-reader' },
  ];
  const spawnProcess = (_command, _args, _options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      const response = responses.shift();
      if (response.stdout) child.stdout.emit('data', response.stdout);
      child.emit('exit', response.exit, null);
    });
    return child;
  };
  await assert.rejects(
    createGit({ root: '/site', spawnProcess }).takeRemote(),
    /could not reapply your local work without conflicts/
  );
});

test('detects a real autostash conflict after Git reports a successful rebase', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'gala-autostash-conflict-'));
  const remote = path.join(workspace, 'remote.git');
  const upstream = path.join(workspace, 'upstream');
  const checkout = path.join(workspace, 'checkout');
  await runTemporaryGit(['init', '--bare', remote]);
  await runTemporaryGit(['clone', remote, upstream]);
  const upstreamGit = (...args) => runTemporaryGit(['-C', upstream, ...args]);
  await upstreamGit('config', 'user.name', 'Gala test');
  await upstreamGit('config', 'user.email', 'test@gala.invalid');
  await writeFile(path.join(upstream, 'site.config.yml'), 'version: 1\n');
  await upstreamGit('add', 'site.config.yml');
  await upstreamGit('commit', '-m', 'base');
  await upstreamGit('push', 'origin', 'HEAD:main');
  await runTemporaryGit(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await runTemporaryGit(['clone', remote, checkout]);
  await writeFile(path.join(upstream, 'site.config.yml'), 'version: 2\n');
  await upstreamGit('commit', '-am', 'remote theme');
  await upstreamGit('push', 'origin', 'HEAD:main');
  await writeFile(path.join(checkout, 'site.config.yml'), 'version: 3\n');

  await assert.rejects(
    createGit({ root: checkout, spawnProcess: spawnTemporaryGit }).takeRemote(),
    /could not reapply your local work without conflicts/
  );
  assert.match(await readFile(path.join(checkout, 'site.config.yml'), 'utf8'), /<<<<<<< Updated upstream/);
  assert.match((await runTemporaryGit(['-C', checkout, 'status', '--short'])).stdout, /UU site\.config\.yml/);
});

test('replays only the verified theme version over an upstream custom-domain change', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'gala-managed-autostash-'));
  const remote = path.join(workspace, 'remote.git');
  const upstream = path.join(workspace, 'upstream');
  const checkout = path.join(workspace, 'checkout');
  const config = (version, base = 'https://writer.github.io', prefix = '/site') =>
    `framework:\n  themePackage:\n    name: "@rathnasgala/theme"\n    version: ${version}\nhosting:\n  canonicalBaseUrl: ${base}\n  pathPrefix: ${prefix}\n`;
  const manifest = (version, reader) => JSON.stringify({
    schemaVersion: 1,
    themePackage: { name: '@rathnasgala/theme', version },
    files: { 'src/assets/reader.js': createHash('sha256').update(reader).digest('hex') },
  }, null, 2) + '\n';
  const writeTheme = async (directory, version) => {
    const reader = `reader-${version}\n`;
    await mkdir(path.join(directory, '.gala'), { recursive: true });
    await mkdir(path.join(directory, 'src/assets'), { recursive: true });
    await writeFile(path.join(directory, '.gala/managed-files.json'), manifest(version, reader));
    await writeFile(path.join(directory, 'site.config.yml'), config(version));
    await writeFile(path.join(directory, 'src/assets/reader.js'), reader);
  };
  await runTemporaryGit(['init', '--bare', remote]);
  await runTemporaryGit(['clone', remote, upstream]);
  const upstreamGit = (...args) => runTemporaryGit(['-C', upstream, ...args]);
  await upstreamGit('config', 'user.name', 'Gala test');
  await upstreamGit('config', 'user.email', 'test@gala.invalid');
  await writeTheme(upstream, '1.0.0');
  await upstreamGit('add', '.');
  await upstreamGit('commit', '-m', 'base');
  await upstreamGit('push', 'origin', 'HEAD:main');
  await runTemporaryGit(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  await runTemporaryGit(['clone', remote, checkout]);
  await writeTheme(upstream, '2.0.0');
  await writeFile(path.join(upstream, 'site.config.yml'),
    config('2.0.0', 'https://blog.example.com', '/'));
  await upstreamGit('commit', '-am', 'remote theme and custom domain');
  await upstreamGit('push', 'origin', 'HEAD:main');
  await writeTheme(checkout, '3.0.0');

  await runTemporaryGit(['-C', checkout, 'fetch', 'origin', 'main']);
  await runTemporaryGit(['-C', checkout, 'rebase', '--autostash', 'origin/main']);
  assert.match((await runTemporaryGit(['-C', checkout, 'status', '--short'])).stdout, /^UU /m);
  await createGit({ root: checkout, spawnProcess: spawnTemporaryGit }).takeRemote();

  assert.equal(await readFile(path.join(checkout, 'src/assets/reader.js'), 'utf8'), 'reader-3.0.0\n');
  const resolved = await readFile(path.join(checkout, 'site.config.yml'), 'utf8');
  assert.match(resolved, /version: 3\.0\.0/);
  assert.match(resolved, /canonicalBaseUrl: https:\/\/blog\.example\.com/);
  assert.match(resolved, /pathPrefix: \/$/m);
  assert.doesNotMatch(resolved, /writer\.github\.io/);
  assert.doesNotMatch((await runTemporaryGit(['-C', checkout, 'status', '--short'])).stdout, /^UU /m);
});

test('populates an empty git repository without replacing its metadata directory', async () => {
  const responses = [
    { exit: 2 },
    { exit: 0 },
    { exit: 0 },
    { exit: 0, stdout: 'ref: refs/heads/main\tHEAD\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tHEAD\n' },
    { exit: 0 },
  ];
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      const response = responses.shift();
      if (response.stdout) child.stdout.emit('data', response.stdout);
      child.emit('exit', response.exit, null);
    });
    return child;
  };

  await populateEmptyRepository({
    url: 'https://github.com/ada/notes.git', target: '/tmp/notes', spawnProcess,
  });

  assert.deepEqual(calls.map(({ args }) => args.at(-1)), [
    'origin', 'https://github.com/ada/notes.git', 'origin', 'HEAD', 'origin/main',
  ]);
  assert.ok(calls.some(({ args }) => args.includes('add')));
  assert.ok(calls.every(({ args }) => !args.includes('clone')));
});

test('repoints an existing origin when populating an empty git repository', async () => {
  const calls = [];
  const responses = [
    { exit: 0, stdout: 'https://example.com/old.git\n' },
    { exit: 0 },
    { exit: 0 },
    { exit: 0, stdout: 'ref: refs/heads/main\tHEAD\n' },
    { exit: 0 },
  ];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      const response = responses.shift();
      if (response.stdout) child.stdout.emit('data', response.stdout);
      child.emit('exit', response.exit, null);
    });
    return child;
  };

  await populateEmptyRepository({
    url: 'https://github.com/ada/notes.git', target: '/tmp/notes', spawnProcess,
  });

  assert.ok(calls.some(({ args }) => args.includes('set-url')));
  assert.ok(!calls.some(({ args }) => args.includes('add')));
});
