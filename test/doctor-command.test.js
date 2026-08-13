import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  diagnoseFramework,
  diagnosePublicationState,
  repairFramework
} from '../src/doctor-command.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-doctor-'));
  await mkdir(path.join(root, '.gala'), { recursive: true });
  await writeFile(path.join(root, 'managed.txt'), 'expected');
  const hash = createHash('sha256').update('expected').digest('hex');
  await writeFile(path.join(root, '.gala', 'managed-files.json'), JSON.stringify({
    schemaVersion: 1,
    files: { 'managed.txt': hash, 'missing.txt': hash }
  }));
  await writeFile(path.join(root, 'custom.css'), 'author owned');
  await mkdir(path.join(root, 'content'), { recursive: true });
  await writeFile(path.join(root, 'content', 'post.md'), 'author content');
  return root;
}

test('reports intact and missing managed files', async () => {
  const root = await fixture();
  assert.deepEqual(await diagnoseFramework(root), [
    { path: 'managed.txt', status: 'intact' },
    { path: 'missing.txt', status: 'missing' }
  ]);
});

test('reports modified managed files without inspecting author files', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'managed.txt'), 'changed');
  const findings = await diagnoseFramework(root);
  assert.deepEqual(findings[0], { path: 'managed.txt', status: 'modified' });
  assert.equal(findings.some(({ path: file }) => file === 'custom.css' || file.startsWith('content/')), false);
});

test('repairs only enumerated files from a hash-verified source', async () => {
  const root = await fixture();
  const source = await fixture();
  await writeFile(path.join(root, 'managed.txt'), 'changed');
  await writeFile(path.join(source, 'missing.txt'), 'expected');

  assert.deepEqual(await repairFramework(root, source), ['managed.txt', 'missing.txt']);
  assert.equal(await readFile(path.join(root, 'managed.txt'), 'utf8'), 'expected');
  assert.equal(await readFile(path.join(root, 'missing.txt'), 'utf8'), 'expected');
  assert.equal(await readFile(path.join(root, 'custom.css'), 'utf8'), 'author owned');
});

test('validates all sources before changing any target', async () => {
  const root = await fixture();
  const source = await fixture();
  await writeFile(path.join(root, 'managed.txt'), 'changed');
  await writeFile(path.join(source, 'missing.txt'), 'tampered');

  await assert.rejects(() => repairFramework(root, source), /hash mismatch/);
  assert.equal(await readFile(path.join(root, 'managed.txt'), 'utf8'), 'changed');
});

test('rolls back every managed file when a later transactional replacement fails', async () => {
  const root = await fixture();
  const source = await fixture();
  await writeFile(path.join(root, 'managed.txt'), 'old-one');
  await writeFile(path.join(root, 'missing.txt'), 'old-two');
  await writeFile(path.join(source, 'missing.txt'), 'expected');
  let installs = 0;
  const renameImpl = async (from, to) => {
    if (from.includes('.gala-repair-') && ++installs === 2) throw new Error('injected replacement failure');
    await rename(from, to);
  };

  await assert.rejects(() => repairFramework(root, source, { renameImpl }), /injected replacement failure/);
  assert.equal(await readFile(path.join(root, 'managed.txt'), 'utf8'), 'old-one');
  assert.equal(await readFile(path.join(root, 'missing.txt'), 'utf8'), 'old-two');
});

test('refuses symbolic-link repair targets', async () => {
  const root = await fixture();
  const source = await fixture();
  const external = path.join(root, 'external.txt');
  await writeFile(external, 'external');
  await writeFile(path.join(source, 'missing.txt'), 'expected');
  await symlink(external, path.join(root, 'missing.txt'));

  await assert.rejects(() => repairFramework(root, source), /Refusing symbolic link/);
  assert.equal(await readFile(external, 'utf8'), 'external');
});

test('refuses symbolic links in a managed path ancestor', async () => {
  const root = await fixture();
  const source = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'gala-outside-'));
  const hash = createHash('sha256').update('expected').digest('hex');
  await writeFile(path.join(source, '.gala', 'managed-files.json'), JSON.stringify({
    schemaVersion: 1,
    files: { 'linked/managed.txt': hash }
  }));
  await mkdir(path.join(source, 'linked'));
  await writeFile(path.join(source, 'linked', 'managed.txt'), 'expected');
  await symlink(outside, path.join(root, 'linked'));

  await assert.rejects(() => repairFramework(root, source), /Refusing symbolic link/);
});

test('a trusted manifest cannot nominate mutable or repository-control paths', async () => {
  for (const protectedPath of [
    '.engagement-snapshot.json', '.git/config', '.github/workflows/publish.yml',
    'CNAME', 'custom.css', 'site.config.yml', 'content/post.md', 'framework/../custom.css'
  ]) {
    const root = await fixture();
    const source = await fixture();
    await writeFile(path.join(root, 'managed.txt'), 'changed');
    const hash = createHash('sha256').update('author owned').digest('hex');
    await writeFile(path.join(source, '.gala', 'managed-files.json'), JSON.stringify({
      schemaVersion: 1,
      files: { 'managed.txt': hash, [protectedPath]: hash }
    }));

    await assert.rejects(() => repairFramework(root, source), /Author-owned path cannot be managed/);
    assert.equal(await readFile(path.join(root, 'managed.txt'), 'utf8'), 'changed');
    assert.equal(await readFile(path.join(root, 'custom.css'), 'utf8'), 'author owned');
    assert.equal(await readFile(path.join(root, 'content', 'post.md'), 'utf8'), 'author content');
  }
});

test('repair ignores a tampered target manifest and restores the trusted one', async () => {
  const root = await fixture();
  const source = await fixture();
  await writeFile(path.join(root, 'managed.txt'), 'changed');
  await writeFile(path.join(source, 'missing.txt'), 'expected');
  const maliciousHash = createHash('sha256').update('author owned').digest('hex');
  await writeFile(path.join(root, '.gala', 'managed-files.json'), JSON.stringify({
    schemaVersion: 1,
    files: { 'custom.css': maliciousHash }
  }));

  assert.deepEqual(await repairFramework(root, source), [
    'managed.txt',
    'missing.txt',
    '.gala/managed-files.json'
  ]);
  assert.equal(await readFile(path.join(root, 'managed.txt'), 'utf8'), 'expected');
  assert.equal(await readFile(path.join(root, 'custom.css'), 'utf8'), 'author owned');
  assert.deepEqual(await diagnoseFramework(root), [
    { path: 'managed.txt', status: 'intact' },
    { path: 'missing.txt', status: 'intact' }
  ]);
});

test('refuses a symbolic-link managed-file manifest', async () => {
  const root = await fixture();
  const source = await fixture();
  const externalManifest = path.join(root, 'external-manifest.json');
  await writeFile(externalManifest, JSON.stringify({ schemaVersion: 1, files: {} }));
  await rm(path.join(root, '.gala', 'managed-files.json'));
  await symlink(externalManifest, path.join(root, '.gala', 'managed-files.json'));

  await assert.rejects(() => diagnoseFramework(root), /Refusing symbolic link/);
  await assert.rejects(() => repairFramework(root, source), /Refusing symbolic link/);
});

test('doctor validates publication state as advisory mutable repository data', async () => {
  const root = await fixture();
  assert.deepEqual(await diagnosePublicationState(root), {
    path: '.gala/publication-state.yml',
    status: 'missing'
  });
  await writeFile(path.join(root, '.gala', 'publication-state.yml'), `schemaVersion: 1
posts: []
`);
  assert.deepEqual(await diagnosePublicationState(root), {
    path: '.gala/publication-state.yml',
    status: 'valid'
  });
  await writeFile(path.join(root, '.gala', 'publication-state.yml'), 'schemaVersion: 99\n');
  const invalid = await diagnosePublicationState(root);
  assert.equal(invalid.status, 'invalid');
  assert.match(invalid.detail, /publication state/);
});
