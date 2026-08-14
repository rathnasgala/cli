import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { previewSite } from '../src/preview-command.js';

async function fixture(date = '2026-06-15') {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-preview-'));
  const directory = path.join(root, 'content', 'posts', 'post');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: UTC
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /notes
  canonicalPolicy: self
`);
  await writeFile(path.join(directory, 'index.en.md'), `---
id: 01K00000000000000000000000
title: Preview
publishAfterDate: ${date}
language: en
---
Body
`);
  return root;
}

test('validates then starts Eleventy through Node without a shell', async () => {
  const root = await fixture();
  const calls = [];
  const spawnProcess = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };

  await previewSite({ root, today: '2026-06-15', spawnProcess });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.match(calls[0][1][0], /node_modules[\\/]@11ty[\\/]eleventy[\\/]cmd\.cjs$/);
  assert.deepEqual(calls[0][1].slice(1), ['--serve', '--watch']);
  assert.equal(calls[0][2].shell, false);
  assert.deepEqual(calls[0][2].stdio, ['inherit', 'pipe', 'pipe']);
  assert.equal(path.isAbsolute(calls[0][2].cwd), true);
  assert.equal(calls[0][2].env.GALA_EVALUATION_DATE, '2026-06-15');
});

test('does not spawn when validation fails', async () => {
  const root = await fixture('invalid');
  let spawned = false;
  await assert.rejects(
    () => previewSite({
      root,
      today: '2026-06-15',
      spawnProcess: () => {
        spawned = true;
      }
    }),
    /Preview refused/
  );
  assert.equal(spawned, false);
});

test('warns after five minutes only until the initial Eleventy build completes', async () => {
  const root = await fixture();
  let child;
  let timerCallback;
  let timerDelay;
  let clearedTimer;
  let signalSpawned;
  const spawned = new Promise((resolve) => { signalSpawned = resolve; });
  const warnings = [];
  const preview = previewSite({
    root,
    today: '2026-06-15',
    spawnProcess: () => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      signalSpawned();
      return child;
    },
    schedule: (callback, delay) => {
      timerCallback = callback;
      timerDelay = delay;
      return 17;
    },
    cancel: (timer) => { clearedTimer = timer; },
    output: { write() {} },
    warningOutput: { write: (value) => warnings.push(String(value)) }
  });

  await spawned;
  assert.equal(timerDelay, 300_001);
  timerCallback();
  assert.deepEqual(warnings, ['warning\tbuild-duration-5m\n']);
  child.stdout.emit('data', Buffer.from('[11ty] Wro'));
  child.stdout.emit('data', Buffer.from('te 2 files in 1.23 seconds'));
  child.emit('exit', 0, null);
  await preview;
  assert.equal(clearedTimer, undefined);
});

test('cancels the duration warning when the initial build finishes promptly', async () => {
  const root = await fixture();
  let timerCallback;
  let clearedTimer;
  const warnings = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('[11ty] Wrote 1 file in 0.01 seconds'));
      child.emit('exit', 0, null);
    });
    return child;
  };

  await previewSite({
    root,
    today: '2026-06-15',
    spawnProcess,
    schedule: (callback) => {
      timerCallback = callback;
      return 23;
    },
    cancel: (timer) => { clearedTimer = timer; },
    output: { write() {} },
    warningOutput: { write: (value) => warnings.push(String(value)) }
  });

  assert.equal(clearedTimer, 23);
  assert.deepEqual(warnings, []);
  assert.equal(typeof timerCallback, 'function');
});
