import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishSite } from '../src/publish-command.js';

async function fixture(body = '# Valid') {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-publish-'));
  const post = path.join(root, 'content', 'posts', 'example');
  await mkdir(post, { recursive: true });
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: UTC
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /
  canonicalPolicy: self
`);
  await writeFile(path.join(post, 'index.en.md'), `---\nid: 01K00000000000000000000000\ntitle: Valid\nslug: valid\npublishAfterDate: 2026-06-15\nlanguage: en\nauthor: Author\n---\n${body}\n`);
  return root;
}

test('validates before an OS-agnostic shell-free push', async () => {
  const root = await fixture();
  let invocation;
  const spawnProcess = (...args) => {
    invocation = args;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };

  await publishSite({ root, today: '2026-06-15', spawnProcess });

  assert.deepEqual(invocation[0], 'git');
  assert.deepEqual(invocation[1], ['-C', root, 'push']);
  assert.equal(invocation[2].shell, false);
});

test('refuses invalid content without starting git', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'content', 'posts', 'example', 'index.en.md'), '---\ntitle: Missing fields\n---\n');
  let started = false;

  await assert.rejects(
    () => publishSite({
      root,
      today: '2026-06-15',
      spawnProcess: () => {
        started = true;
      }
    }),
    /Publish refused/
  );
  assert.equal(started, false);
});

test('force bypasses validation without force-pushing', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'content', 'posts', 'example', 'index.en.md'), 'invalid');
  let gitArgs;
  const spawnProcess = (_command, args) => {
    gitArgs = args;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };

  await publishSite({ root, today: '2026-06-15', force: true, spawnProcess });
  assert.deepEqual(gitArgs, ['-C', root, 'push']);
});
