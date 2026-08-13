import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as tar from 'tar';
import { parse } from 'yaml';

import { inspectActionUpgrade, upgradeTheme } from '../src/upgrade-command.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-upgrade-'));
  await mkdir(path.join(root, '.gala'));
  await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(root, 'managed.txt'), 'old');
  const oldHash = createHash('sha256').update('old').digest('hex');
  await writeFile(path.join(root, '.gala', 'managed-files.json'), JSON.stringify({
    schemaVersion: 1, files: { 'managed.txt': oldHash },
    themePackage: { name: '@rathnasgala/theme', version: '0.0.1', availableDesignThemes: ['editorial'] }
  }));
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
design:
  theme: editorial
framework:
  themePackage:
    name: "@rathnasgala/theme"
    version: "0.0.1"
`);
  await writeFile(path.join(root, '.github', 'workflows', 'publish.yml'), `jobs:
  publish:
    uses: rathnasgala/publish/.github/workflows/publish.yml@v1
`);
  return root;
}

async function packageArchive() {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-upgrade-package-'));
  await mkdir(path.join(root, 'package', 'payload', '.gala'), { recursive: true });
  await writeFile(path.join(root, 'package', 'payload', 'managed.txt'), 'new');
  const hash = createHash('sha256').update('new').digest('hex');
  await writeFile(path.join(root, 'package', 'payload', '.gala', 'managed-files.json'), JSON.stringify({
    schemaVersion: 1, files: { 'managed.txt': hash },
    themePackage: { name: '@rathnasgala/theme', version: '0.0.2', availableDesignThemes: ['editorial'] }
  }));
  const chunks = [];
  for await (const chunk of tar.c({ cwd: root, gzip: true }, ['package'])) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('resolves a channel, confirms, and atomically updates managed bytes plus the exact config pin', async () => {
  const root = await fixture();
  const archive = await packageArchive();
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  const fetchImpl = async (url) => {
    if (url.includes('api.github.com/repos/rathnasgala/publish/tags')) {
      return new Response(JSON.stringify([{ name: 'v2' }, { name: 'v1.4.0' }]));
    }
    if (url.endsWith(encodeURIComponent('@rathnasgala/theme'))) {
      return new Response(JSON.stringify({ 'dist-tags': { latest: '0.0.2', next: '0.1.0-beta.1' } }));
    }
    if (url.includes('registry.npmjs.org')) return new Response(JSON.stringify({
      name: '@rathnasgala/theme', version: '0.0.2',
      dist: { tarball: 'https://registry.example/theme.tgz', integrity }
    }));
    return new Response(archive);
  };

  const result = await upgradeTheme({ root, confirm: async () => true, fetchImpl });

  assert.equal(result.changed, true);
  assert.deepEqual(result.action, { currentMajor: 1, latestMajor: 2, newerAvailable: true });
  assert.equal(await readFile(path.join(root, 'managed.txt'), 'utf8'), 'new');
  assert.equal(parse(await readFile(path.join(root, 'site.config.yml'), 'utf8')).framework.themePackage.version, '0.0.2');
});

test('does not download or mutate when confirmation is declined', async () => {
  const root = await fixture();
  let calls = 0;
  const result = await upgradeTheme({
    root, confirm: async () => false,
    fetchImpl: async (url) => {
      calls += 1;
      if (url.includes('api.github.com')) return new Response(JSON.stringify([{ name: 'v1.2.3' }]));
      return new Response(JSON.stringify({ 'dist-tags': { latest: '0.0.2' } }));
    }
  });
  assert.equal(result.cancelled, true);
  assert.equal(calls, 2);
  assert.deepEqual(result.action, { currentMajor: 1, latestMajor: 1, newerAvailable: false });
  assert.equal(await readFile(path.join(root, 'managed.txt'), 'utf8'), 'old');
});

test('rejects an ambiguous workflow instead of inventing the installed action major', async () => {
  const root = await fixture();
  await writeFile(path.join(root, '.github', 'workflows', 'publish.yml'), `jobs:
  first:
    uses: rathnasgala/publish/.github/workflows/publish.yml@v1
  second:
    uses: rathnasgala/publish/.github/workflows/publish.yml@v2
`);
  let fetched = false;
  await assert.rejects(inspectActionUpgrade({
    root,
    fetchImpl: async () => { fetched = true; return new Response('[]'); }
  }), /exactly one Gala action major/);
  assert.equal(fetched, false);
});

test('ignores unrelated tags and reports the highest released action major', async () => {
  const root = await fixture();
  const result = await inspectActionUpgrade({
    root,
    fetchImpl: async () => new Response(JSON.stringify([
      { name: 'not-a-release' }, { name: 'v3.0.0' }, { name: 'v2-beta' }, { name: 'v1' }
    ]))
  });
  assert.deepEqual(result, { currentMajor: 1, latestMajor: 3, newerAvailable: true });
});
