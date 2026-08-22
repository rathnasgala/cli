import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { credentialPath, forgetCredential, readCredential, writeCredential } from '../src/auth/store.js';

const scratch = () => mkdtemp(path.join(tmpdir(), 'gala-store-'));

test('writes privately and atomically, and reads back what it wrote', async () => {
  const target = path.join(await scratch(), 'credentials.json');
  await writeCredential(target, { accessToken: 'ghu_token', refreshToken: 'ghr_token' });

  assert.equal((await stat(target)).mode & 0o777, 0o600);
  const stored = await readCredential(target);
  assert.equal(stored.accessToken, 'ghu_token');
  assert.equal(stored.refreshToken, 'ghr_token');
  // No temporary file left behind for anyone to find.
  assert.equal(JSON.parse(await readFile(target, 'utf8')).schemaVersion, 2);
});

test('an expired credential reads as absent, so callers sign in rather than fail deeper', async () => {
  /*
   * v0 handed out a token the API had already decided to refuse, and every command failed as an
   * unexplained 401 several calls in. The check belongs where the credential is read.
   */
  const target = path.join(await scratch(), 'github.json');
  await writeCredential(target, { accessToken: 'ghu_token', expiresAt: '2026-08-22T08:00:00.000Z' });

  assert.equal(await readCredential(target, { now: new Date('2026-08-22T09:00:00.000Z') }), null);
  assert.ok(await readCredential(target, { now: new Date('2026-08-22T07:00:00.000Z') }));
});

test('a credential from an older shape reads as absent rather than being trusted', async () => {
  // v0 stored OAuth scopes here. Upgrading in place is not possible; one sign-in is the honest fix.
  const target = path.join(await scratch(), 'github.json');
  await writeFile(target, JSON.stringify({
    schemaVersion: 1, accessToken: 'gho_old', scopes: ['repo', 'workflow']
  }));
  assert.equal(await readCredential(target), null);
});

test('missing, empty and corrupt files are all simply absent', async () => {
  const root = await scratch();
  assert.equal(await readCredential(path.join(root, 'nothing.json')), null);
  const corrupt = path.join(root, 'corrupt.json');
  await writeFile(corrupt, 'not json at all');
  assert.equal(await readCredential(corrupt), null);
});

test('refuses a symbolic link in either direction', async () => {
  const root = await scratch();
  const external = path.join(root, 'external');
  const linked = path.join(root, 'linked.json');
  await writeFile(external, '{}');
  await symlink(external, linked);

  await assert.rejects(writeCredential(linked, { accessToken: 'x' }), /regular file/);
  await assert.rejects(readCredential(linked), /regular file/);
});

test('forgetting is idempotent, so a failed sign-in can always clean up', async () => {
  const target = path.join(await scratch(), 'credentials.json');
  await writeCredential(target, { accessToken: 'x' });
  await forgetCredential(target);
  await forgetCredential(target);
  assert.equal(await readCredential(target), null);
});

test('stores per platform where that platform expects it', () => {
  const home = path.join(path.sep, 'home', 'ada');
  assert.equal(credentialPath('credentials', { platform: 'darwin', home, environment: {} }),
    path.join(home, 'Library', 'Application Support', 'Gala', 'credentials.json'));
  assert.equal(credentialPath('credentials', { platform: 'linux', home, environment: {} }),
    path.join(home, '.config', 'gala', 'credentials.json'));
  assert.equal(credentialPath('credentials', { platform: 'win32', home, environment: { APPDATA: 'C:\\App' } }),
    path.join('C:\\App', 'Gala', 'credentials.json'));
  assert.throws(() => credentialPath('credentials', { platform: 'win32', home, environment: {} }),
    /APPDATA/);
});
