import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { EventEmitter } from 'node:events';

import { recordDeployment } from '../src/record-deployment-command.js';
import { BUILD_MANIFEST_PATH } from '../src/validate-command.js';

const DEPLOYED_SHA = 'a'.repeat(40);
const RECORDED_STATE_SHA = 'b'.repeat(40);

function gitRunner(codes, calls) {
  let headReads = 0;
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    const isHead = args.includes('rev-parse');
    const code = isHead ? 0 : codes.shift();
    queueMicrotask(() => {
      if (isHead) {
        child.stdout.emit('data', `${headReads === 0 ? DEPLOYED_SHA : RECORDED_STATE_SHA}\n`);
        headReads += 1;
      }
      child.emit('exit', code, null);
    });
    return child;
  };
}

test('records, path-scopes, commits, and pushes the post-deployment state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-record-deployment-'));
  await mkdir(path.join(root, path.dirname(BUILD_MANIFEST_PATH)), { recursive: true });
  const postPath = 'content/posts/post/index.en.md';
  await mkdir(path.join(root, path.dirname(postPath)), { recursive: true });
  const postSource = `---
id: 01K00000000000000000000000
title: Post
publishAfterDate: 2026-08-11
language: en
---
Body
`;
  await writeFile(path.join(root, postPath), postSource);
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: America/Los_Angeles
`);
  await writeFile(path.join(root, BUILD_MANIFEST_PATH), JSON.stringify({
    schemaVersion: 1,
    evaluationDate: '2026-08-11',
    redirects: [],
    assignedContentIds: [{
      source: postPath,
      id: '01K00000000000000000000000',
      fileHash: (await import('node:crypto')).createHash('sha256').update(postSource).digest('hex')
    }],
    posts: [{
      source: 'content/posts/post/index.en.md',
      id: '01K00000000000000000000000',
      slug: 'post',
      language: 'en',
      publicationState: 'published'
    }]
  }));

  const calls = [];
  const result = await recordDeployment({
    root,
    now: () => Date.parse('2026-08-12T06:30:00Z'),
    deployedCommitSha: DEPLOYED_SHA,
    spawnProcess: gitRunner([0, 1, 0, 0], calls)
  });
  assert.equal(result.state.posts[0].languages.en.firstPublishedOn, '2026-08-11');
  assert.equal(result.state.deployedCommitSha, DEPLOYED_SHA);
  assert.equal(result.pushed, true);
  assert.equal(result.recordedStateSha, RECORDED_STATE_SHA);
  assert.deepEqual(
    parse(await readFile(path.join(root, '.gala', 'publication-state.yml'), 'utf8')),
    result.state
  );
  assert.deepEqual(calls.map(({ args }) => args), [
    ['-C', root, 'rev-parse', '--verify', 'HEAD'],
    ['-C', root, 'add', '--', '.gala/publication-state.yml', postPath],
    ['-C', root, 'diff', '--cached', '--quiet', '--exit-code', '--',
      '.gala/publication-state.yml', postPath],
    ['-C', root, 'commit', '--only', '-m',
      'chore(gala): record successful deployment [skip ci]\n\n'
      + `Gala-Deployed-SHA: ${DEPLOYED_SHA}\n`
      + `Gala-Assigned-ID: 01K00000000000000000000000 ${postPath}`, '--',
      '.gala/publication-state.yml', postPath],
    ['-C', root, 'rev-parse', '--verify', 'HEAD'],
    ['-C', root, 'push']
  ]);
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test('refuses to commit an assigned-ID file whose bytes changed after deployment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-record-deployment-'));
  const postPath = 'content/posts/post/index.en.md';
  await mkdir(path.join(root, path.dirname(BUILD_MANIFEST_PATH)), { recursive: true });
  await mkdir(path.join(root, path.dirname(postPath)), { recursive: true });
  await writeFile(path.join(root, postPath), 'changed after deployment');
  await writeFile(path.join(root, BUILD_MANIFEST_PATH), JSON.stringify({
    schemaVersion: 1,
    evaluationDate: '2026-08-11',
    redirects: [],
    assignedContentIds: [{
      source: postPath,
      id: '01K00000000000000000000000',
      fileHash: 'b'.repeat(64)
    }],
    posts: []
  }));

  await assert.rejects(() => recordDeployment({
    root,
    deployedOn: '2026-08-11',
    deployedCommitSha: DEPLOYED_SHA,
    spawnProcess: gitRunner([], [])
  }), /changed after the deployed build/);
});

test('an unchanged state is idempotent and does not commit or push', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-record-deployment-'));
  await mkdir(path.join(root, path.dirname(BUILD_MANIFEST_PATH)), { recursive: true });
  await writeFile(path.join(root, BUILD_MANIFEST_PATH), JSON.stringify({
    schemaVersion: 1, evaluationDate: '2026-08-11', redirects: [], posts: []
  }));
  const calls = [];
  const result = await recordDeployment({
    root,
    deployedOn: '2026-08-11',
    deployedCommitSha: DEPLOYED_SHA,
    spawnProcess: gitRunner([0, 0], calls)
  });
  assert.equal(result.pushed, false);
  assert.equal(calls.length, 3);
});

test('refuses to record a deployment SHA different from checkout HEAD', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-record-deployment-'));
  await mkdir(path.join(root, path.dirname(BUILD_MANIFEST_PATH)), { recursive: true });
  await writeFile(path.join(root, BUILD_MANIFEST_PATH), JSON.stringify({
    schemaVersion: 1, evaluationDate: '2026-08-11', redirects: [], posts: []
  }));
  await assert.rejects(() => recordDeployment({
    root,
    deployedOn: '2026-08-11',
    deployedCommitSha: 'b'.repeat(40),
    spawnProcess: gitRunner([], [])
  }), /does not match checkout HEAD/);
});

test('never infers a deployed SHA from mutable checkout state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-record-deployment-'));
  await mkdir(path.join(root, path.dirname(BUILD_MANIFEST_PATH)), { recursive: true });
  await writeFile(path.join(root, BUILD_MANIFEST_PATH), JSON.stringify({
    schemaVersion: 1, evaluationDate: '2026-08-11', redirects: [], posts: []
  }));
  await assert.rejects(() => recordDeployment({
    root,
    deployedOn: '2026-08-11',
    spawnProcess: () => { throw new Error('git must not run'); }
  }), /requires --commit-sha/);
});

test('refuses acknowledgment without the exact current build manifest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-record-deployment-'));
  await assert.rejects(() => recordDeployment({ root, deployedOn: '2026-08-11' }),
    /manifest is missing/);
});
