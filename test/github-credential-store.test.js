import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readGithubCredential, writeGithubCredential } from '../src/github-credential-store.js';

test('stores required GitHub scopes atomically with private permissions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-github-credential-'));
  const target = path.join(root, 'config', 'github.json');
  await writeGithubCredential({ accessToken: 'token', scopes: ['repo', 'workflow'], target });
  assert.equal((await lstat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readGithubCredential({ target }), {
    accessToken: 'token', scopes: ['repo', 'workflow']
  });
  assert.doesNotMatch(await readFile(target, 'utf8'), /Ov23/);
});

test('rejects missing scopes and symbolic-link credential targets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-github-credential-'));
  await assert.rejects(
    writeGithubCredential({ accessToken: 'token', scopes: ['repo'], target: path.join(root, 'github.json') }),
    /repo and workflow/
  );
  const external = path.join(root, 'external');
  const linked = path.join(root, 'linked');
  await writeFile(external, '{}');
  await symlink(external, linked);
  await assert.rejects(
    writeGithubCredential({ accessToken: 'token', scopes: ['repo', 'workflow'], target: linked }),
    /regular file/
  );
});
