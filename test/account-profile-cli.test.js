import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { profilePaths } from '../src/auth/profiles.js';
import { credentialPath, writeCredential } from '../src/auth/store.js';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const future = '2099-01-01T00:00:00.000Z';

async function environment() {
  const home = await mkdtemp(path.join(tmpdir(), 'gala-profile-cli-'));
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      NO_COLOR: '1',
    },
  };
}

async function seed(home, env, name, email, githubLogin) {
  const root = path.dirname(credentialPath('credentials', { environment: env, home }));
  const paths = profilePaths(name, { root });
  await mkdir(paths.directory, { recursive: true });
  await writeCredential(paths.gala, { accessToken: `gala-${name}`, expiresAt: future });
  await writeCredential(paths.github, { accessToken: `github-${name}`, expiresAt: future });
  await writeFile(paths.metadata, JSON.stringify({
    schemaVersion: 2, name,
    gala: { userId: '01M00000000000000000000001', email, displayName: name },
    githubLogin,
  }));
  return { root, paths };
}

const invoke = (args, env, cwd) => run(process.execPath, [entry, ...args], { env, cwd })
  .then((result) => ({ code: 0, ...result }), (failure) => failure);

test('auth list shows exact Gala/GitHub pairs and marks only the selected profile', async () => {
  const fixture = await environment();
  const forum = await seed(fixture.home, fixture.env, 'rathnastest',
    'anandchakru.forum@gmail.com', 'rathnastest');
  await seed(fixture.home, fixture.env, 'rfai8me', 'rfai8me@gmail.com', 'rfai8me');
  await writeFile(forum.paths.active, 'rathnastest\n');
  const result = await invoke(['auth', 'list'], fixture.env);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\* rathnastest: Gala anandchakru\.forum@gmail\.com \+ GitHub @rathnastest/);
  assert.match(result.stdout, /\srfai8me: Gala rfai8me@gmail\.com \+ GitHub @rfai8me/);
});

test('auth use changes only the named pointer and refuses unknown profiles', async () => {
  const fixture = await environment();
  const forum = await seed(fixture.home, fixture.env, 'rathnastest',
    'anandchakru.forum@gmail.com', 'rathnastest');
  await seed(fixture.home, fixture.env, 'rfai8me', 'rfai8me@gmail.com', 'rfai8me');
  assert.equal((await invoke(['auth', 'use', 'rfai8me'], fixture.env)).code, 0);
  assert.equal(await readFile(forum.paths.active, 'utf8'), 'rfai8me\n');
  const missing = await invoke(['auth', 'use', 'missing'], fixture.env);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /profile missing is incomplete/);
  assert.equal(await readFile(forum.paths.active, 'utf8'), 'rfai8me\n');
});

test('auth remove deletes one profile without touching another profile credentials', async () => {
  const fixture = await environment();
  const forum = await seed(fixture.home, fixture.env, 'rathnastest',
    'anandchakru.forum@gmail.com', 'rathnastest');
  const rfai = await seed(fixture.home, fixture.env, 'rfai8me', 'rfai8me@gmail.com', 'rfai8me');
  const result = await invoke(['auth', 'remove', 'rathnastest'], fixture.env);
  assert.equal(result.code, 0);
  await assert.rejects(stat(forum.paths.directory), { code: 'ENOENT' });
  assert.ok((await stat(rfai.paths.directory)).isDirectory());
  assert.equal((await readFile(rfai.paths.gala, 'utf8')).includes('gala-rfai8me'), true);
});

test('init without --account automatically uses the active profile', async () => {
  const fixture = await environment();
  const rfai = await seed(fixture.home, fixture.env, 'rfai8me', 'rfai8me@gmail.com', 'rfai8me');
  await writeFile(rfai.paths.active, 'rfai8me\n');
  const parent = await mkdtemp(path.join(tmpdir(), 'gala-init-account-'));
  const destination = path.join(parent, 'must-not-exist');
  const result = await invoke(['init', destination, '--name', 'must-not-exist'], fixture.env, parent);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /account|terminal to ask/i);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('init rejects an unknown explicit profile before creating a destination', async () => {
  const fixture = await environment();
  const parent = await mkdtemp(path.join(tmpdir(), 'gala-init-account-'));
  const destination = path.join(parent, 'must-not-exist');
  const result = await invoke([
    'init', destination, '--name', 'must-not-exist', '--account', 'unknown',
  ], fixture.env, parent);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /profile unknown is incomplete/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('publish refuses a contradictory profile before invoking any Git operation', async () => {
  const fixture = await environment();
  await seed(fixture.home, fixture.env, 'rathnastest', 'anandchakru.forum@gmail.com', 'rathnastest');
  await seed(fixture.home, fixture.env, 'rfai8me', 'rfai8me@gmail.com', 'rfai8me');
  const checkout = await mkdtemp(path.join(tmpdir(), 'gala-publish-account-'));
  await mkdir(path.join(checkout, '.git'));
  await writeFile(path.join(checkout, '.git', 'gala-account-profile'), 'rathnastest\n');
  const result = await invoke(['publish', '--account', 'rfai8me'], fixture.env, checkout);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /belongs to account profile rathnastest/);
  assert.doesNotMatch(result.stderr, /git .*exited/);
});

test('profile-management grammar rejects missing names, extras and unsafe names', async () => {
  const fixture = await environment();
  for (const args of [
    ['auth', 'add', 'alias'], ['auth', 'use'], ['auth', 'remove'], ['auth', 'list', 'extra'],
    ['auth', 'use', '../escape'], ['auth', 'unknown'],
  ]) {
    const result = await invoke(args, fixture.env);
    assert.equal(result.code, 1, args.join(' '));
  }
});
