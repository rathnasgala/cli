import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));

const invoke = (args, options = {}) => run(process.execPath, [entry, ...args], {
  env: { ...process.env, NO_COLOR: '1' }, ...options
}).then((ok) => ({ code: 0, ...ok }), (failure) => failure);

test('lists the seven supported author commands and no removed internals', async () => {
  /*
   * v0 had fifteen. The extra nine were the ones nobody could keep working — a `validate` a hook
   * ran behind the writer's back, a `workflow` writer for a file the server owns, a
   * `record-deployment` nothing called. Each was a surface to keep correct and a way to be wrong.
   */
  const { stdout } = await invoke(['--help']);
  for (const command of ['auth', 'init', 'new', 'preview', 'publish', 'upgrade', 'doctor']) {
    assert.match(stdout, new RegExp(`\\b${command}\\b`), command);
  }
  for (const gone of ['scaffold', 'validate', 'workflow', 'record-deployment', 'configure',
    'topology', 'refresh', 'entitlement', 'hook']) {
    assert.doesNotMatch(stdout, new RegExp(`\\b${gone}\\b`), gone);
  }
});

test('exits 0 for help asked for, 1 for no command at all', async () => {
  assert.equal((await invoke(['--help'])).code, 0);
  assert.equal((await invoke(['help'])).code, 0);
  assert.equal((await invoke([])).code, 1);
});

test('an unknown command names it and shows what does exist', async () => {
  const failure = await invoke(['scaffold']);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /there is no scaffold command/);
  assert.match(failure.stdout, /gala <command>/);
});

test('a mistyped option fails before anything happens', async () => {
  // The point of parsing up front: no credential is read, no repository is touched.
  const failure = await invoke(['init', '--nmae', 'notes']);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /unknown option --nmae/);
});

test('every command explains itself', async () => {
  for (const command of ['auth', 'init', 'new', 'preview', 'publish', 'upgrade', 'doctor']) {
    const { stdout, code } = await invoke([command, '--help']);
    assert.equal(code, 0, command);
    assert.match(stdout, /gala /, command);
  }
});

test('a failure is one line the writer can act on, with the stack behind GALA_DEBUG', async () => {
  /*
   * A rejected top-level await prints a stack through node_modules by default, which buries the
   * only line that matters. Anyone debugging the CLI itself is a different audience from anyone
   * trying to publish.
   */
  const empty = await mkdtemp(path.join(tmpdir(), 'gala-cli-'));
  const plain = await invoke(['new'], { cwd: empty });
  assert.equal(plain.code, 1);
  assert.doesNotMatch(plain.stderr, /\n\s+at /);

  const debugged = await invoke(['new'], { cwd: empty, env: { ...process.env, GALA_DEBUG: '1' } });
  assert.equal(debugged.code, 1);
  assert.match(debugged.stderr, /\n\s+at /);
});

test('refuses to prompt when there is no terminal, naming the option instead', async () => {
  // Piped input means CI. Guessing a publication name here would create a repository nobody asked
  // for, under a name nobody chose.
  const empty = await mkdtemp(path.join(tmpdir(), 'gala-cli-'));
  const failure = await invoke(['new'], { cwd: empty });
  assert.match(failure.stderr, /no terminal to ask/);
});
