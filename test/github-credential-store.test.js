import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readGithubCredential, writeGithubCredential } from '../src/github-credential-store.js';

test('stores required GitHub scopes atomically with private permissions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-github-credential-'));
  const target = path.join(root, 'config', 'github.json');
  await writeGithubCredential({ accessToken: 'token', target });
  assert.equal((await lstat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readGithubCredential({ target }), {
    accessToken: 'token'
  });
  assert.doesNotMatch(await readFile(target, 'utf8'), /Ov23/);
});

test('rejects a stale OAuth credential and symbolic-link targets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-github-credential-'));

  /*
   * A schema-1 file holds an OAuth App token. It cannot list App installations and organisations
   * with OAuth App restrictions refuse it outright, so it is unusable — and saying so here sends
   * the writer through one `auth github` rather than leaving them to decode a 403 several calls
   * deeper.
   */
  const stale = path.join(root, 'stale.json');
  await writeFile(stale, JSON.stringify({
    schemaVersion: 1, accessToken: 'gho_old', scopes: ['repo', 'workflow']
  }));
  await assert.rejects(readGithubCredential({ target: stale }), /out of date.*auth github/);

  await assert.rejects(
    writeGithubCredential({ accessToken: '', target: path.join(root, 'github.json') }),
    /accessToken is required/
  );

  const external = path.join(root, 'external');
  const linked = path.join(root, 'linked');
  await writeFile(external, '{}');
  await symlink(external, linked);
  await assert.rejects(
    writeGithubCredential({ accessToken: 'token', target: linked }),
    /regular file/
  );
});

test('an expired GitHub credential asks for a sign-in rather than being handed out', async () => {
  /*
   * The app expires user tokens after eight hours. Returning one anyway means the failure surfaces
   * as a 401 from whichever call happens to run first — which is precisely how a legacy Gala token
   * cost days of diagnosis. The check belongs where the credential is read.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'gala-github-expiry-'));
  const target = path.join(root, 'github.json');
  const now = new Date('2026-08-22T09:00:00.000Z');

  await writeGithubCredential({
    accessToken: 'ghu_token',
    expiresAt: new Date('2026-08-22T08:00:00.000Z'),
    refreshToken: 'ghr_token',
    target
  });
  await assert.rejects(readGithubCredential({ target, now }), /expired.*auth github/);

  await writeGithubCredential({
    accessToken: 'ghu_token',
    expiresAt: new Date('2026-08-22T17:00:00.000Z'),
    refreshToken: 'ghr_token',
    target
  });
  const live = await readGithubCredential({ target, now });
  assert.equal(live.accessToken, 'ghu_token');
  assert.equal(live.refreshToken, 'ghr_token');
  assert.equal(live.expiresAt.toISOString(), '2026-08-22T17:00:00.000Z');
});
