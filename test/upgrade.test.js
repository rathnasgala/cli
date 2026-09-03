import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { c as createTar } from 'tar';

import { upgrade } from '../src/commands/upgrade.js';

const options = (values = {}, switches = {}) => ({
  value: (name) => values[name],
  on: (name) => switches[name] === true,
});
const terminal = () => {
  const messages = [];
  return {
    messages,
    result: (value) => messages.push(value),
    note: (value) => messages.push(value),
    done: (value) => messages.push(value),
    ask: async () => 'no',
  };
};

async function installedSite(version = '2.0.0') {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-upgrade-installed-'));
  await mkdir(path.join(root, '.gala'), { recursive: true });
  await writeFile(path.join(root, '.gala', 'managed-files.json'), JSON.stringify({
    schemaVersion: 1,
    themePackage: { name: '@rathnasgala/theme', version },
    files: {},
  }));
  return root;
}

test('reports an exact current release without downloading or changing files', async () => {
  const root = await installedSite();
  const output = terminal();
  const installed = JSON.parse(await readFile(path.join(root, '.gala', 'managed-files.json'), 'utf8'));
  const version = installed.themePackage.version;
  const fetchImpl = async () => new Response(JSON.stringify({
    'dist-tags': { latest: version },
    versions: { [version]: { dist: { tarball: 'https://registry.example/theme.tgz', integrity: 'sha512-AA==' } } },
  }));

  const result = await upgrade({ terminal: output, options: options({ root }), fetchImpl });

  assert.deepEqual(result, { changed: false, version });
  assert.match(output.messages.join('\n'), /Already current/);
});

test('repairs stale performance budgets when the managed theme is already current', async () => {
  const root = await installedSite();
  await writeFile(path.join(root, '.gala', 'managed-files.json'), JSON.stringify({
    schemaVersion: 1,
    themePackage: { name: '@rathnasgala/theme', version: '2.0.0' },
    requiredBudgets: { managedJavaScriptBytes: 94208, managedCssBytes: 36864 },
    files: {},
  }));
  await writeFile(path.join(root, 'site.config.yml'), `framework:
  themePackage:
    version: 2.0.0
performance:
  budgets:
    managedJavaScriptBytes: 87040
    managedCssBytes: 34816
    ordinaryHtmlBytes: 32768
`);
  const output = terminal();
  const fetchImpl = async () => new Response(JSON.stringify({
    'dist-tags': { latest: '2.0.0' },
    versions: {
      '2.0.0': { dist: { tarball: 'https://registry.example/theme.tgz', integrity: 'sha512-AA==' } },
    },
  }));

  const result = await upgrade({
    terminal: output, options: options({ root }, { yes: true }), fetchImpl,
  });

  assert.deepEqual(result, { changed: true, version: '2.0.0' });
  const upgradedConfig = await readFile(path.join(root, 'site.config.yml'), 'utf8');
  assert.match(upgradedConfig, /managedJavaScriptBytes: 94208/);
  assert.match(upgradedConfig, /managedCssBytes: 36864/);
  assert.match(output.messages.join('\n'), /Updated performance budgets/);
  const second = await upgrade({ terminal: terminal(), options: options({ root }), fetchImpl });
  assert.deepEqual(second, { changed: false, version: '2.0.0' });
});

test('refuses a channel outside the two documented release tracks', async () => {
  const root = await installedSite();
  await assert.rejects(
    () => upgrade({ terminal: terminal(), options: options({ root, channel: 'beta' }) }),
    /channel must be latest or next/,
  );
});

test('migrates mandatory workflow permissions even when the theme is already current', async () => {
  const root = await installedSite();
  await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  const workflow = path.join(root, '.github', 'workflows', 'publish.yml');
  await writeFile(workflow, `name: Publish
permissions:
  contents: write
jobs:
  publish:
    uses: rathnasgala/publish/.github/workflows/publish.yml@v1
`);
  const fetchImpl = async () => new Response(JSON.stringify({
    'dist-tags': { latest: '2.0.0' },
    versions: { '2.0.0': { dist: { tarball: 'https://registry.example/theme.tgz', integrity: 'sha512-AA==' } } },
  }));

  const result = await upgrade({
    terminal: terminal(), options: options({ root }, { yes: true }), fetchImpl,
  });

  assert.deepEqual(result, { changed: true, version: '2.0.0' });
  assert.match(await readFile(workflow, 'utf8'),
    /permissions:\n  contents: write\n  id-token: write\n  attestations: write\n/);
  const second = await upgrade({ terminal: terminal(), options: options({ root }), fetchImpl });
  assert.deepEqual(second, { changed: false, version: '2.0.0' });
});

test('refuses an unsupported workflow without changing it', async () => {
  const root = await installedSite();
  await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  const workflow = path.join(root, '.github', 'workflows', 'publish.yml');
  const original = 'permissions:\n  contents: read\n';
  await writeFile(workflow, original);
  const fetchImpl = async () => new Response(JSON.stringify({
    'dist-tags': { latest: '2.0.0' },
    versions: { '2.0.0': { dist: { tarball: 'https://registry.example/theme.tgz', integrity: 'sha512-AA==' } } },
  }));

  await assert.rejects(
    () => upgrade({ terminal: terminal(), options: options({ root }, { yes: true }), fetchImpl }),
    /must grant contents: write/,
  );
  assert.equal(await readFile(workflow, 'utf8'), original);
});

test('commits the new managed manifest so the installed release is coherent', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'gala-upgrade-test-'));
  const site = path.join(temporary, 'site');
  const packageRoot = path.join(temporary, 'package');
  const payload = path.join(packageRoot, 'payload');
  await mkdir(path.join(site, '.gala'), { recursive: true });
  await mkdir(path.join(site, '.github', 'workflows'), { recursive: true });
  await mkdir(path.join(payload, '.gala'), { recursive: true });
  const oldBytes = Buffer.from('old runtime\n');
  const newBytes = Buffer.from('new runtime\n');
  await writeFile(path.join(site, 'runtime.js'), oldBytes);
  await writeFile(path.join(site, '.github', 'workflows', 'publish.yml'),
    'permissions:\n  contents: write\n');
  await writeFile(path.join(site, 'site.config.yml'), `framework:
  themePackage:
    version: 1.0.0
performance:
  budgets:
    managedJavaScriptBytes: 100000
    managedCssBytes: 34816
    ordinaryHtmlBytes: 32768
`);
  const installed = {
    schemaVersion: 1,
    themePackage: { name: '@rathnasgala/theme', version: '1.0.0' },
    files: { 'runtime.js': createHash('sha256').update(oldBytes).digest('hex') },
  };
  await writeFile(path.join(site, '.gala', 'managed-files.json'), JSON.stringify(installed));
  await writeFile(path.join(payload, 'runtime.js'), newBytes);
  const available = {
    schemaVersion: 1,
    themePackage: { name: '@rathnasgala/theme', version: '2.0.0' },
    requiredBudgets: { managedJavaScriptBytes: 94208, managedCssBytes: 36864 },
    files: { 'runtime.js': createHash('sha256').update(newBytes).digest('hex') },
  };
  await writeFile(path.join(payload, '.gala', 'managed-files.json'), JSON.stringify(available));
  const archive = path.join(temporary, 'theme.tgz');
  await createTar({ gzip: true, cwd: temporary, file: archive }, ['package']);
  const archiveBytes = await readFile(archive);
  const integrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;
  const fetchImpl = async (url) => url.includes('registry.npmjs.org')
    ? new Response(JSON.stringify({
      'dist-tags': { latest: '2.0.0' },
      versions: { '2.0.0': { dist: { tarball: 'https://registry.example/theme.tgz', integrity } } },
    }))
    : new Response(archiveBytes);

  await upgrade({ terminal: terminal(), options: options({ root: site }, { yes: true }), fetchImpl });

  assert.equal(await readFile(path.join(site, 'runtime.js'), 'utf8'), 'new runtime\n');
  assert.match(await readFile(path.join(site, '.github', 'workflows', 'publish.yml'), 'utf8'),
    /contents: write\n  id-token: write\n  attestations: write/);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(site, '.gala', 'managed-files.json'), 'utf8')),
    available,
  );
  const upgradedConfig = await readFile(path.join(site, 'site.config.yml'), 'utf8');
  assert.match(upgradedConfig, /managedJavaScriptBytes: 100000/);
  assert.match(upgradedConfig, /managedCssBytes: 36864/);
  assert.match(upgradedConfig, /ordinaryHtmlBytes: 32768/);
  const second = await upgrade({ terminal: terminal(), options: options({ root: site }), fetchImpl });
  assert.deepEqual(second, { changed: false, version: '2.0.0' });
});
