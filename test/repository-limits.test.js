import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectRepositoryLimits, repositoryLimitWarnings } from '../src/repository-limits.js';

function gitMetadata(output) {
  return (command, args, options) => {
    assert.equal(command, 'git');
    assert.equal(args.at(-2), 'count-objects');
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', output);
      child.emit('exit', 0, null);
    });
    return child;
  };
}

test('classifies the exact documented thresholds', () => {
  assert.deepEqual(repositoryLimitWarnings({ repositoryBytes: 500 * 1024 * 1024, postCount: 1000 }), []);
  assert.deepEqual(
    repositoryLimitWarnings({ repositoryBytes: 501 * 1024 * 1024, postCount: 1001 }),
    [
      { severity: 'warning', code: 'repository-size-500mb' },
      { severity: 'warning', code: 'post-count-1000' }
    ]
  );
  assert.deepEqual(
    repositoryLimitWarnings({ repositoryBytes: 801 * 1024 * 1024, postCount: 0, buildDurationMs: 300001 }),
    [
      { severity: 'critical', code: 'repository-size-800mb' },
      { severity: 'warning', code: 'build-duration-5m' }
    ]
  );
});

test('inspects Git metadata without a shell and counts post variants', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-limits-'));
  const posts = path.join(root, 'content', 'posts', 'example');
  await mkdir(posts, { recursive: true });
  await writeFile(path.join(posts, 'index.en.md'), 'post');
  await writeFile(path.join(posts, 'index.fr.md'), 'post');

  const result = await inspectRepositoryLimits(root, {
    spawnProcess: gitMetadata('count: 1\nsize: 512001\nin-pack: 0\nsize-pack: 0\n')
  });

  assert.equal(result.repositoryBytes, 512001 * 1024);
  assert.equal(result.postCount, 2);
  assert.deepEqual(result.warnings, [{ severity: 'warning', code: 'repository-size-500mb' }]);
});
