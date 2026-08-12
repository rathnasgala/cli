import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installPrePushHook } from '../src/hook-command.js';

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-hook-'));
  await mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
  return root;
}

test('installs an idempotent shell-free Node pre-push validator', async () => {
  const root = await repository();
  const first = await installPrePushHook(root);
  const second = await installPrePushHook(root);
  const source = await readFile(first.target, 'utf8');

  assert.equal(first.installed, true);
  assert.equal(second.installed, false);
  assert.match(source, /^#!\/usr\/bin\/env node/);
  assert.match(source, /shell: false/);
  assert.match(source, /'validate'/);
  assert.doesNotMatch(source, /new Date|--today/);
});

test('never overwrites an author hook', async () => {
  const root = await repository();
  const target = path.join(root, '.git', 'hooks', 'pre-push');
  await writeFile(target, '#!/bin/sh\necho author-owned\n');

  await assert.rejects(() => installPrePushHook(root), /Refusing to overwrite/);
  assert.equal(await readFile(target, 'utf8'), '#!/bin/sh\necho author-owned\n');
});

test('refuses a linked hooks directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-hook-link-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'gala-hook-outside-'));
  await mkdir(path.join(root, '.git'));
  await symlink(outside, path.join(root, '.git', 'hooks'));

  await assert.rejects(() => installPrePushHook(root), /real directory/);
});
